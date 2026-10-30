// ACP agent wiring: `initialize`, `session/new`, `session/prompt` and the
// `session/cancel` notification, backed by an injected pane factory.

import { agent, methods, PROTOCOL_VERSION, RequestError, type AgentApp } from "@agentclientprotocol/sdk";
import type { ContentBlock, SessionId, SessionUpdate } from "@agentclientprotocol/sdk";
import {
  DEFAULT_BRIDGE_CONFIG,
  INTERRUPT_KEY,
  runTurn,
  systemClock,
  type BridgeConfig,
  type TurnNotice,
} from "./bridge.ts";
import type { PaneFactory, SessionPane } from "./pane.ts";

export const ADAPTER_NAME = "freebuff-acp-adapter";
export const ADAPTER_VERSION = "0.1.0";

export type AdapterOptions = {
  /** Creates (and starts) the pane for a `session/new` request. */
  createPane: PaneFactory;
  /** Timing overrides for the bridge; tests pass a fake clock through `now`/`sleep`. */
  bridge?: Partial<BridgeConfig>;
};

export type SessionState = {
  pane: SessionPane;
  cancelled: boolean;
  prompting: boolean;
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

  return agent({ name: ADAPTER_NAME })
    .onRequest(methods.agent.initialize, ({ params }) => ({
      protocolVersion:
        typeof params.protocolVersion === "number" && params.protocolVersion <= PROTOCOL_VERSION
          ? params.protocolVersion
          : PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      authMethods: [],
      agentInfo: { name: ADAPTER_NAME, version: ADAPTER_VERSION },
    }))
    .onRequest(methods.agent.session.new, async ({ params }) => {
      const sessionId = newSessionId();
      try {
        const pane = await options.createPane({ sessionId, cwd: params.cwd });
        sessions.set(sessionId, { pane, cancelled: false, prompting: false });
        return { sessionId };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new RequestError(-32000, `failed to start the Freebuff pane: ${detail}`);
      }
    })
    .onRequest(methods.agent.session.prompt, async ({ params, signal, client }) => {
      const session = sessions.get(params.sessionId);
      if (session === undefined) {
        throw new RequestError(-32002, `unknown session '${params.sessionId}'`);
      }
      if (session.prompting) {
        throw new RequestError(-32000, "a prompt turn is already active for this session");
      }
      session.prompting = true;
      session.cancelled = false;
      try {
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
