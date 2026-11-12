// ACP agent wiring: `initialize`, `session/new`, `session/load`,
// `session/prompt` and the `session/cancel` notification, backed by an injected
// pane factory.

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
      let pane: SessionPane;
      try {
        pane = await options.createPane({ sessionId: params.sessionId, cwd: params.cwd, resume: true });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RequestError(-32000, `failed to resume the Freebuff pane: ${detail}`);
      }
      const state: SessionState = { pane, cancelled: false, prompting: false, cwd: params.cwd };
      sessions.set(params.sessionId, state);

      // Freebuff holds the conversation: reopen it, then replay what the pane
      // shows so the host's transcript matches the agent's. The promise is kept
      // on the session state so a prompt that arrives meanwhile waits for it.
      const resuming = (async () => {
        const resumed = await resumeChat({ pane, config, title: known?.title ?? null });
        store.set(params.sessionId, { cwd: params.cwd, title: resumed.title ?? known?.title ?? null });
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
        const result = await runTurn({
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

let sessionCounter = 0;

/** Unique, tmux-safe session id (also used as the tmux session name). */
export function newSessionId(): string {
  sessionCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `freebuff-acp-${sessionCounter}-${random}`;
}
