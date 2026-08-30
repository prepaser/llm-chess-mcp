import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { buildServer } from "./server.js";
import {
  hasUnexpectedBody,
  isCancellationPostBody,
  parsePostBody,
} from "./http-body.js";
import { canonicalHttpPath } from "./http-config.js";
import type { HttpLimits } from "./http-config.js";
import { HttpPostAdmission } from "./http-posts.js";
import { closeWithError } from "./http-response.js";
import { HttpSessionRegistry } from "./http-sessions.js";
import { HttpWorkAdmission, withSessionWorkAdmission } from "./http-work.js";
import type { AppServices } from "./services.js";

type Session = {
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  abort: AbortController;
  lastUsedAt: number;
  activeRequests: number;
  activePosts: number;
  controlPosts: { activePosts: number };
};

function requestPath(req: IncomingMessage): string | null {
  const raw = req.url;
  if (raw === undefined) return null;
  const queryIndex = raw.search(/[?#]/);
  return canonicalHttpPath(queryIndex === -1 ? raw : raw.slice(0, queryIndex));
}

function sessionId(req: IncomingMessage): string | null | undefined {
  const value = req.headers["mcp-session-id"];
  if (value === undefined) return undefined;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class HttpRuntime {
  readonly #sessions: HttpSessionRegistry<Session>;
  readonly #bodyAdmission: HttpPostAdmission<{ activePosts: number }>;
  readonly #controlBodyAdmission: HttpPostAdmission<{ activePosts: number }>;
  readonly #workAdmission: HttpWorkAdmission;
  readonly #postAdmission: HttpPostAdmission<Session>;
  readonly #controlPostAdmission: HttpPostAdmission<Session["controlPosts"]>;
  #closing = false;
  #sessionSweep: NodeJS.Timeout | undefined;
  #shutdown: Promise<void> | undefined;

  constructor(
    private readonly services: AppServices,
    private readonly path: string,
    private readonly allowedHosts: string[],
    private readonly limits: HttpLimits,
  ) {
    this.#sessions = new HttpSessionRegistry<Session>(limits.maxSessions);
    this.#bodyAdmission = new HttpPostAdmission(
      limits.maxConcurrentPosts,
      limits.maxConcurrentPosts,
    );
    this.#controlBodyAdmission = new HttpPostAdmission(
      limits.maxConcurrentPostsPerSession,
      limits.maxConcurrentPostsPerSession,
    );
    this.#workAdmission = new HttpWorkAdmission(
      limits.maxConcurrentPosts,
      limits.maxConcurrentPostsPerSession,
    );
    this.#postAdmission = new HttpPostAdmission<Session>(
      limits.maxConcurrentPosts,
      limits.maxConcurrentPostsPerSession,
    );
    this.#controlPostAdmission = new HttpPostAdmission<Session["controlPosts"]>(
      limits.maxConcurrentPosts,
      limits.maxConcurrentPostsPerSession,
    );
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  start(): void {
    if (this.#sessionSweep || this.#closing) return;
    this.#sessionSweep = setInterval(() => {
      void this.#reapExpiredSessions();
    }, this.limits.sessionSweepIntervalMs);
    this.#sessionSweep.unref();
  }

  handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    return this.#handle(req, res);
  }

  close(): Promise<void> {
    return (this.#shutdown ??= this.#close());
  }

  async #stopSession(session: Session): Promise<void> {
    session.abort.abort(new DOMException("MCP session closed", "AbortError"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.server.close();
  }

  #closeSession(id: string, session: Session): Promise<void> {
    return this.#sessions.close(id, session, (value) => this.#stopSession(value));
  }

  #reapExpiredSessions(): Promise<void> {
    return this.#sessions.reap(
      this.limits.sessionIdleTtlMs,
      (session) => this.#stopSession(session),
    );
  }

  async #withParsedPostBody(
    req: IncomingMessage,
    res: ServerResponse,
    work: (body: unknown) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const primary = this.#bodyAdmission.tryAcquire();
    const admission =
      typeof primary === "object"
        ? primary
        : this.#controlBodyAdmission.tryAcquire();
    if (typeof admission !== "object") {
      closeWithError(req, res, 503, "server request body limit reached", {
        "retry-after": "1",
      });
      return;
    }
    let body: Awaited<ReturnType<typeof parsePostBody>>;
    try {
      body = await parsePostBody(
        req,
        this.limits.maxRequestBodyBytes,
        this.limits.bodyTimeoutMs,
        signal,
      );
    } finally {
      admission.release();
    }
    if (!body.ok) {
      closeWithError(req, res, body.status, body.message);
      return;
    }
    await work(body.value);
  }

  #closeSessionOnResponseDisconnect(
    id: string,
    session: Session,
    res: ServerResponse,
  ): () => void {
    let finished = res.writableEnded;
    const onFinish = (): void => {
      finished = true;
    };
    const onClose = (): void => {
      if (finished) return;
      void this.#closeSession(id, session).catch((error: unknown) => {
        console.error("failed to close disconnected MCP session", error);
      });
    };
    res.once("finish", onFinish);
    res.once("close", onClose);
    if (res.destroyed) onClose();
    return () => {
      res.off("finish", onFinish);
      res.off("close", onClose);
    };
  }

  async #withAdmittedPost(
    session: Session | undefined,
    req: IncomingMessage,
    res: ServerResponse,
    body: unknown,
    work: () => Promise<void>,
  ): Promise<void> {
    const admission = this.#postAdmission.tryAcquire(session);
    if (admission === 429 || admission === 503) {
      if (session && isCancellationPostBody(body)) {
        const controlAdmission = this.#controlPostAdmission.tryAcquire(
          session.controlPosts,
        );
        if (typeof controlAdmission === "object") {
          try {
            await work();
          } finally {
            controlAdmission.release();
          }
          return;
        }
      }
      if (admission === 429) {
        closeWithError(req, res, 429, "MCP session request limit reached", {
          "retry-after": "1",
        });
      } else {
        closeWithError(req, res, 503, "server request limit reached", {
          "retry-after": "1",
        });
      }
      return;
    }
    try {
      await work();
    } finally {
      admission.release();
    }
  }

  async #handleExistingSession(
    id: string,
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method === "DELETE") {
      const protocolVersion = req.headers["mcp-protocol-version"];
      if (
        protocolVersion !== undefined &&
        (typeof protocolVersion !== "string" ||
          !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion))
      ) {
        closeWithError(req, res, 400, "unsupported MCP protocol version");
        return;
      }
      await this.#closeSession(id, session);
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "POST") {
      const stopWatching = this.#closeSessionOnResponseDisconnect(id, session, res);
      try {
        await this.#sessions.withActive(session, () =>
          this.#withParsedPostBody(
            req,
            res,
            (body) =>
              this.#withAdmittedPost(session, req, res, body, () =>
                session.transport.handleRequest(req, res, body),
              ),
            session.abort.signal,
          ),
        );
      } finally {
        stopWatching();
      }
      return;
    }
    await this.#sessions.withActive(session, () =>
      session.transport.handleRequest(req, res),
    );
  }

  async #handleInitialization(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (req.method !== "POST") {
      closeWithError(req, res, 400, "MCP session initialization requires POST");
      return;
    }
    await this.#withParsedPostBody(req, res, (body) =>
      this.#withAdmittedPost(undefined, req, res, body, async () => {
        if (!isInitializeRequest(body)) {
          closeWithError(req, res, 400, "MCP session initialization required");
          return;
        }
        await this.#reapExpiredSessions();
        if (this.#closing) {
          closeWithError(req, res, 503, "server is shutting down", {
            "retry-after": "1",
          });
          return;
        }
        const reservation = this.#sessions.tryReserve();
        if (!reservation) {
          closeWithError(req, res, 503, "MCP session limit reached", {
            "retry-after": "1",
          });
          return;
        }
        try {
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => reservation.initialized(id),
            onsessionclosed: (id) => reservation.closed(id),
          });
          const abort = new AbortController();
          const mcp = buildServer(
            withSessionWorkAdmission(
              this.services,
              this.#workAdmission.forSession(abort.signal),
            ),
          );
          const session: Session = {
            server: mcp,
            transport,
            abort,
            lastUsedAt: this.#sessions.time(),
            activeRequests: 0,
            activePosts: 0,
            controlPosts: { activePosts: 0 },
          };
          reservation.attach(session);
          transport.onclose = () => {
            session.abort.abort(new DOMException("MCP session closed", "AbortError"));
            reservation.close();
          };
          try {
            await this.#sessions.withActive(session, async () => {
              await mcp.connect(transport);
              await transport.handleRequest(req, res, body);
            });
          } finally {
            if (!reservation.finish()) await mcp.close();
          }
        } catch (error) {
          reservation.finish();
          throw error;
        }
      }),
    );
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.#closing) {
      closeWithError(req, res, 503, "server is shutting down", {
        "retry-after": "1",
      });
      return;
    }
    if (requestPath(req) !== this.path) {
      closeWithError(req, res, 404, "MCP endpoint not found");
      return;
    }
    const host = validateHostHeader(req.headers.host, this.allowedHosts);
    if (!host.ok) {
      closeWithError(req, res, 403, host.message);
      return;
    }
    const origin = validateOriginHeader(req.headers.origin, this.allowedHosts);
    if (!origin.ok) {
      closeWithError(req, res, 403, origin.message);
      return;
    }
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      closeWithError(req, res, 405, "MCP method not allowed", {
        allow: "GET, POST, DELETE",
      });
      return;
    }
    if (req.method !== "POST" && hasUnexpectedBody(req)) {
      closeWithError(req, res, 400, "GET and DELETE requests must not include a body");
      return;
    }

    const id = sessionId(req);
    if (id === null) {
      closeWithError(req, res, 400, "invalid MCP session ID");
      return;
    }
    if (id === undefined) {
      await this.#handleInitialization(req, res);
      return;
    }
    const session = this.#sessions.get(id);
    if (!session) {
      closeWithError(req, res, 404, "MCP session not found");
      return;
    }
    await this.#handleExistingSession(id, session, req, res);
  }

  async #close(): Promise<void> {
    this.#closing = true;
    if (this.#sessionSweep) clearInterval(this.#sessionSweep);
    await this.#sessions.closeAll((session) => this.#stopSession(session));
  }
}
