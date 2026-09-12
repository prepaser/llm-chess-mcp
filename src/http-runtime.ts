import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateHostHeader,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { buildServer } from "./server.js";
import {
  hasUnexpectedBody,
  isCancellationPostBody,
  MAX_CANCELLATION_PROBE_BYTES,
  parsePostBody,
} from "./http-body.js";
import type { HttpLimits } from "./http-config.js";
import { HttpBodyAdmission, HttpPostAdmission } from "./http-posts.js";
import { closeWithError } from "./http-response.js";
import { HttpSessionRegistry } from "./http-sessions.js";
import { HttpWorkAdmission, withSessionWorkAdmission } from "./http-work.js";
import type { AppServices } from "./services.js";
import { BearerAuthenticator, HttpSecurity, TrustedProxySet } from "./http-security.js";
import { HttpRequestPolicy, rateError, requestPath, sessionId } from "./http-policy.js";
import { withHttpWorkBudget } from "./http-invocation.js";
import { ANONYMOUS_GAME_SCOPE, createScopedGameRepository } from "./games.js";
import type { SecuritySubject, SecurityLease, RateLimitDecision } from "./http-security.js";

type Session = {
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  abort: AbortController;
  lastUsedAt: number;
  activeRequests: number;
  activePosts: number;
  controlPosts: { activePosts: number };
  owner: string | undefined;
  quota: SecurityLease;
};


export class HttpRuntime {
  readonly #sessions: HttpSessionRegistry<Session>;
  readonly #bodyAdmission: HttpBodyAdmission;
  readonly #workAdmission: HttpWorkAdmission;
  readonly #postAdmission: HttpPostAdmission<Session>;
  readonly #controlPostAdmission: HttpPostAdmission<Session["controlPosts"]>;
  #closing = false;
  #sessionSweep: NodeJS.Timeout | undefined;
  #shutdown: Promise<void> | undefined;
  readonly #requestContext = new AsyncLocalStorage<SecuritySubject>();
  readonly #controlOnly = new WeakMap<IncomingMessage, RateLimitDecision>();
  readonly #policy: HttpRequestPolicy;

  constructor(
    private readonly services: AppServices,
    private readonly path: string,
    private readonly allowedHosts: string[],
    private readonly limits: HttpLimits,
    private readonly security = new HttpSecurity(),
    auth = new BearerAuthenticator(),
    proxies = new TrustedProxySet(),
  ) {
    if (auth.enabled && typeof services.games.forScope !== "function") {
      throw new Error("authenticated HTTP requires a scope-aware game repository");
    }
    this.#policy = new HttpRequestPolicy(path, allowedHosts, security, auth, proxies);
    this.#sessions = new HttpSessionRegistry<Session>(limits.maxSessions);
    this.#bodyAdmission = new HttpBodyAdmission(
      limits.maxConcurrentPosts,
      limits.maxConnections,
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
    const admitted = this.#policy.admit(req, res);
    if (!admitted) return Promise.resolve();
    if (admitted.controlOnly) this.#controlOnly.set(req, admitted.controlOnly);
    return this.#requestContext.run(admitted.subject, () => this.#handle(req, res));
  }

  close(): Promise<void> {
    return (this.#shutdown ??= this.#close());
  }

  async #stopSession(session: Session): Promise<void> {
    session.abort.abort(new DOMException("MCP session closed", "AbortError"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      await session.server.close();
    } finally {
      session.quota.release();
    }
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
    const admission = this.#bodyAdmission.acquire();
    if (!admission) {
      closeWithError(req, res, 503, "server request body limit reached", {
        "retry-after": "1",
      });
      return;
    }
    let body: Awaited<ReturnType<typeof parsePostBody>>;
    try {
      body = await parsePostBody(
        req,
        admission.kind === "full" && !this.#controlOnly.has(req)
          ? this.limits.maxRequestBodyBytes
          : Math.min(this.limits.maxRequestBodyBytes, MAX_CANCELLATION_PROBE_BYTES),
        this.limits.bodyTimeoutMs,
        signal,
      );
    } finally {
      admission.release();
    }
    if (!body.ok) {
      const limited = this.#controlOnly.get(req);
      if (limited) {
        rateError(req, res, limited);
        return;
      }
      if (admission.kind === "probe") {
        closeWithError(req, res, 503, "server request body limit reached", {
          "retry-after": "1",
        });
        return;
      }
      closeWithError(
        req,
        res,
        body.status,
        body.message,
      );
      return;
    }
    const limited = this.#controlOnly.get(req);
    if (limited && !isCancellationPostBody(body.value)) {
      rateError(req, res, limited);
      return;
    }
    if (!limited && isCancellationPostBody(body.value)) {
      const subject = this.#requestContext.getStore();
      if (!subject) throw new Error("missing HTTP request context");
      const control = this.security.consume("control", subject);
      if (!control.allowed) {
        rateError(req, res, control);
        return;
      }
    }
    if (admission.kind === "probe" && !isCancellationPostBody(body.value)) {
      closeWithError(req, res, 503, "server request body limit reached", {
        "retry-after": "1",
      });
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
    const subject = this.#requestContext.getStore();
    if (!subject) throw new Error("missing HTTP request context");
    const rate = this.security.consume("initialize", subject);
    if (!rate.allowed) {
      rateError(req, res, rate);
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
        const quota = this.security.acquire("session", subject);
        if (!("release" in quota)) {
          reservation.finish();
          rateError(req, res, quota);
          return;
        }
        try {
          const transport = new NodeStreamableHTTPServerTransport({
            sessionIdGenerator: randomUUID,
            onsessioninitialized: (id) => reservation.initialized(id),
            onsessionclosed: (id) => reservation.closed(id),
          });
          const abort = new AbortController();
          const owner = typeof subject.bearer === "string" ? subject.bearer : subject.bearer?.digest;
          const games = this.services.games.forScope
            ? createScopedGameRepository(this.services.games, owner ? `bearer:${owner}` : ANONYMOUS_GAME_SCOPE)
            : this.services.games;
          const run = this.#workAdmission.forSession(abort.signal);
          const mcp = buildServer(
            withSessionWorkAdmission(
              this.services,
              withHttpWorkBudget(run, this.security, () => this.#requestContext.getStore()),
              games,
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
            owner,
            quota,
          };
          reservation.attach(session);
          transport.onclose = () => {
            session.abort.abort(new DOMException("MCP session closed", "AbortError"));
            reservation.close();
            quota.release();
          };
          try {
            await this.#sessions.withActive(session, async () => {
              await mcp.connect(transport);
              await transport.handleRequest(req, res, body);
            });
          } finally {
            if (!reservation.finish()) {
              quota.release();
              await mcp.close();
            }
          }
        } catch (error) {
          reservation.finish();
          quota.release();
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
    const subject = this.#requestContext.getStore();
    const owner = typeof subject?.bearer === "string" ? subject.bearer : subject?.bearer?.digest;
    if (!session || session.owner !== owner) {
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
