// ACP agent wiring: `initialize`, `session/new`, `session/load`,
// `session/prompt` and the `session/cancel` notification, backed by an injected
// pane factory.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp } from "@agentclientprotocol/sdk";
import type { ContentBlock, SessionId, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  DEFAULT_BRIDGE_CONFIG,
  INTERRUPT_KEY,
  resumeChat,
  runTurn,
  systemClock,
  type BridgeConfig,
  type TurnNotice,
  type TurnResult,
} from "./bridge.ts";
import { chatTitle } from "./screen.ts";
import type { PaneFactory, SessionPane } from "./pane.ts";
import { fileSessionStore, type SessionStore } from "./store.ts";

export const ADAPTER_NAME = "freebuff-acp-adapter";
export const ADAPTER_VERSION = "0.1.0";

export type AdapterOptions = {
  /** Creates (and starts) the pane for a `session/new` request. */
  createPane: PaneFactory;
  /** Timing overrides for the bridge; tests pass a fake clock through `now`/`sleep`. */
  bridge?: Partial<BridgeConfig>;
  /** Where per-session resume records live; defaults to an on-disk store. */
  store?: SessionStore;
};

export type SessionState = {
  pane: SessionPane;
  cancelled: boolean;
  prompting: boolean;
  /** Working directory the session runs in, needed to resume it. */
  cwd: string;
  /**
   * Set while a `session/load` is still reopening the conversation. Hosts send
   * a wake prompt as soon as the connection is up, and its keystrokes would
   * otherwise land in the middle of the adapter driving `/history`.
   */
  resuming?: Promise<void>;
};

/** Extracts the plain text a prompt carries; non-text blocks are ignored. */
export function promptTextFromBlocks(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter((text) => text !== "")
    .join("\n");
}

/** Builds the ACP agent app. The caller connects it to a transport. */
export function createAdapter(options: AdapterOptions): AgentApp {
  const clock = systemClock();
  const config: BridgeConfig = {
    ...DEFAULT_BRIDGE_CONFIG,
    ...options.bridge,
    now: options.bridge?.now ?? clock.now,
    sleep: options.bridge?.sleep ?? clock.sleep,
  };
  const sessions = new Map<SessionId, SessionState>();
  /** Session ids whose resume is between the guards and a registered pane. */
  const loading = new Set<SessionId>();
  const store = options.store ?? fileSessionStore();

  /** Records which chat of which directory this session is talking in. */
  const recordSession = async (sessionId: SessionId, state: SessionState): Promise<void> => {
    let title: string | null = null;
    try {
      title = chatTitle(await state.pane.capture());
    } catch {
      // The pane is gone: keep whatever title was recorded before.
    }
    store.set(sessionId, { cwd: state.cwd, title: title ?? store.get(sessionId)?.title ?? null });
  };

  return agent({ name: ADAPTER_NAME })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion:
        typeof params.protocolVersion === "number" && params.protocolVersion <= PROTOCOL_VERSION
          ? params.protocolVersion
          : PROTOCOL_VERSION,
      agentCapabilities: {
        // Resume is real here: Freebuff keeps the conversation, and `--continue`
        // plus its `/history` picker can reopen the right chat in a new pane.
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
      agentInfo: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = newSessionId();
      try {
        const pane = await options.createPane({ sessionId, cwd: params.cwd });
        const state: SessionState = { pane, cancelled: false, prompting: false, cwd: params.cwd };
        sessions.set(sessionId, state);
        void recordSession(sessionId, state);
        return { sessionId };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RequestError(-32000, `failed to start the Freebuff pane: ${detail}`);
      }
    })
    .onRequest(methods.agent.session.load, async ({ params, client }) => {
      const known = store.get(params.sessionId);
      // A conversation is identified by its recorded directory *and* title: the
      // title is the only handle the TUI exposes, so a load that cannot name the
      // chat it wants would settle on whatever `--continue` happens to open.
      if (known === undefined || known.title === null) {
        throw new RequestError(-32000, `session '${params.sessionId}' has no recorded conversation to resume`);
      }
      // A conversation lives in the directory it was started in. Reopening it
      // elsewhere keeps the recorded title while opening a different chat, and a
      // same-titled chat in the new directory would pass the title comparison.
      if (known.cwd !== params.cwd && canonicalDir(known.cwd) !== canonicalDir(params.cwd)) {
        throw new RequestError(
          -32000,
          `session '${params.sessionId}' was recorded in '${known.cwd}' and cannot be reopened in '${params.cwd}'`,
        );
      }
      // A load replaces the session's entry with a new pane under the same tmux
      // name, which the resume path kills first: a turn still running on the old
      // state would send its keys into the replacement.
      const previous = sessions.get(params.sessionId);
      if (previous?.prompting === true || previous?.resuming !== undefined) {
        throw new RequestError(-32000, `session '${params.sessionId}' is busy`);
      }
      // The SDK keeps reading while a handler awaits, so a second load for the
      // same id would pass the guards above before the first one registers its
      // pane, and both would start a tmux session under the same name.
      if (loading.has(params.sessionId)) {
        throw new RequestError(-32000, `session '${params.sessionId}' is busy`);
      }
      loading.add(params.sessionId);
      let pane: SessionPane;
      try {
        pane = await options.createPane({ sessionId: params.sessionId, cwd: params.cwd, resume: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RequestError(-32000, `failed to resume the Freebuff pane: ${detail}`);
      } finally {
        loading.delete(params.sessionId);
      }
      const state: SessionState = { pane, cancelled: false, prompting: false, cwd: params.cwd };
      sessions.set(params.sessionId, state);

      // Freebuff holds the conversation: reopen it, then replay what the pane
      // shows so the host's transcript matches the agent's. The promise is kept
      // on the session state so a prompt that arrives meanwhile waits for it.
      const recordedTitle = known.title;
      const resuming = (async () => {
        const resumed = await resumeChat({ pane, config, title: recordedTitle });
        // A chat that could not be restored is some other conversation: binding
        // it to this session would replay the wrong transcript and rename the
        // record to a title the host never asked for.
        if (!resumed.restored) {
          throw new Error(`the requested chat '${recordedTitle}' is not in this directory's history`);
        }
        store.set(params.sessionId, { cwd: params.cwd, title: resumed.title ?? recordedTitle });
        for (const message of resumed.messages) {
          await client.notify(methods.client.session.update, {
            sessionId: params.sessionId,
            update:
              message.role === "user"
                ? { sessionUpdate: "user_message_chunk", content: { type: "text", text: message.text } }
                : { sessionUpdate: "agent_message_chunk", content: { type: "text", text: message.text } },
          });
        }
      })();
      state.resuming = resuming;
      try {
        await resuming;
      } catch (err) {
        // The conversation could not be reopened, so the pane is of no use to
        // anyone: close it instead of leaving a TUI running unattended.
        sessions.delete(params.sessionId);
        try {
          await pane.stop();
        } catch {
          // Already gone.
        }
        const detail = err instanceof Error ? err.message : String(err);
        throw new RequestError(-32000, `failed to resume the conversation: ${detail}`);
      } finally {
        state.resuming = undefined;
      }
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) {
        throw new RequestError(-32002, `unknown session '${params.sessionId}'`);
      }
      if (session.prompting) {
        throw new RequestError(-32000, "a prompt turn is already active for this session");
      }
      // Claim the session before awaiting anything, or two prompts that arrive
      // during a resume both pass the check above and are typed into the same
      // composer, arriving as one garbled message.
      session.prompting = true;
      session.cancelled = false;
      try {
        // A host wakes a resumed session with a prompt straight away; typing it
        // before the conversation is reopened would fight the picker navigation.
        if (session.resuming !== undefined) {
          await session.resuming;
        }
        let result: TurnResult;
        try {
          result = await runTurn({
            pane: session.pane,
            promptText: promptTextFromBlocks(params.prompt),
            config,
            events: {
            onChunk: (text) =>
              client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              }),
            onNotice: (notice) =>
              client.notify(methods.client.session.update, {
                sessionId: params.sessionId,
                update: noticeUpdate(notice),
              }),
              isCancelled: () => session.cancelled || signal.aborted,
            },
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          throw new RequestError(-32000, `the Freebuff pane could not take the prompt: ${detail}`);
        }
        // The chat title tracks the first prompt, so it changes during a turn:
        // record it once the turn is over so a later resume can find this chat.
        await recordSession(params.sessionId, session);
        return { stopReason: result.stopReason };
      } finally {
        session.prompting = false;
      }
    })
    .onNotification(methods.agent.session.cancel, async ({ params }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) {
        return;
      }
      session.cancelled = true;
      // The TUI's interrupt key stops the in-flight turn (Ctrl-C in Freebuff).
      await session.pane.send(INTERRUPT_KEY);
    });
}

function noticeUpdate(notice: TurnNotice): SessionUpdate {
  return {
    sessionUpdate: "notice",
    severity: notice.severity,
    title: notice.title,
    description: notice.description ?? null,
  };
}

/**
 * Resolves a directory for comparison, so `/tmp/x` and `/tmp/x/` are one place.
 * Falls back to a normalized path when the directory no longer exists.
 */
function canonicalDir(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

let sessionCounter = 0;

/** Unique, tmux-safe session id (also used as the tmux session name). */
export function newSessionId(): string {
  sessionCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `freebuff-acp-${sessionCounter}-${random}`;
}
