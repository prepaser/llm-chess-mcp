import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import {
  isInitializeRequest,
  isJSONRPCNotification,
  SUPPORTED_PROTOCOL_VERSIONS,
  validateHostHeader,
  validateOriginHeader,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { buildServer } from "./server.js";
import {
  HttpWorkAdmission,
  withSessionWorkAdmission,
} from "./http-work.js";
import {
  bindHttpHost,
  canonicalHttpHostname,
  canonicalHttpPath,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isWildcardHttpBindHost,
} from "./http-config.js";
import { HttpPostAdmission } from "./http-posts.js";
import { HttpSessionRegistry } from "./http-sessions.js";
import { acquireDefaultAppServices, defaultAppServices } from "./services.js";
import type { AppServices } from "./services.js";

export type HttpServerOptions = {
  host?: string;
  port?: number;
  path?: string;
  allowedHosts?: readonly string[];
  maxSessions?: number;
  sessionIdleTtlMs?: number;
  sessionSweepIntervalMs?: number;
  maxRequestBodyBytes?: number;
  maxConcurrentPosts?: number;
  maxConcurrentPostsPerSession?: number;
  maxConnections?: number;
  maxHeaderBytes?: number;
  maxHeaderCount?: number;
  headersTimeoutMs?: number;
  /** Request body deadline; takes precedence over requestTimeoutMs. */
  bodyTimeoutMs?: number;
  /** @deprecated Use bodyTimeoutMs; used only when bodyTimeoutMs is omitted. */
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  keepAliveTimeoutMs?: number;
};

export type HttpServerHandle = {
  host: string;
  port: number;
  path: string;
  url: string;
  sessionCount(): number;
  close(): Promise<void>;
};

type Session = {
  server: McpServer;
  transport: NodeStreamableHTTPServerTransport;
  abort: AbortController;
  lastUsedAt: number;
  activeRequests: number;
  activePosts: number;
  controlPosts: { activePosts: number };
};

type HttpLimits = Required<
  Omit<HttpServerOptions, "host" | "port" | "path" | "allowedHosts" | "requestTimeoutMs">
>;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DEFAULT_LIMITS: HttpLimits = {
  maxSessions: 64,
  sessionIdleTtlMs: 30 * 60 * 1_000,
  sessionSweepIntervalMs: 30_000,
  maxRequestBodyBytes: 2 * 1024 * 1024,
  maxConcurrentPosts: 16,
  maxConcurrentPostsPerSession: 2,
  maxConnections: 128,
  maxHeaderBytes: 16 * 1024,
  maxHeaderCount: 100,
  headersTimeoutMs: 10_000,
  bodyTimeoutMs: 15_000,
  socketTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
};

function isLocalHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function normalizeIpv4BindHost(host: string): string {
  const canonical = canonicalHttpHostname(host);
  return canonical && /^\d+(?:\.\d+){3}$/.test(canonical) ? canonical : host;
}

function jsonError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_000, message },
      id: null,
    }),
  );
}

function closeWithError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  res.shouldKeepAlive = false;
  res.once("finish", () => req.destroy());
  jsonError(res, status, message, { connection: "close", ...headers });
}

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

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function positiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`);
  }
}

function timerDelay(name: string, value: number): void {
  positiveInteger(name, value);
  if (!Number.isSafeInteger(value) || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(
      `${name} must be a safe integer between 1 and ${MAX_TIMER_DELAY_MS}`,
    );
  }
}

function resolveLimits(options: HttpServerOptions): HttpLimits {
  if (options.bodyTimeoutMs !== undefined) {
    timerDelay("bodyTimeoutMs", options.bodyTimeoutMs);
  }
  if (options.requestTimeoutMs !== undefined) {
    timerDelay("requestTimeoutMs", options.requestTimeoutMs);
  }
  const limits: HttpLimits = {
    maxSessions: options.maxSessions ?? DEFAULT_LIMITS.maxSessions,
    sessionIdleTtlMs: options.sessionIdleTtlMs ?? DEFAULT_LIMITS.sessionIdleTtlMs,
    sessionSweepIntervalMs:
      options.sessionSweepIntervalMs ?? DEFAULT_LIMITS.sessionSweepIntervalMs,
    maxRequestBodyBytes:
      options.maxRequestBodyBytes ?? DEFAULT_LIMITS.maxRequestBodyBytes,
    maxConcurrentPosts: options.maxConcurrentPosts ?? DEFAULT_LIMITS.maxConcurrentPosts,
    maxConcurrentPostsPerSession:
      options.maxConcurrentPostsPerSession ??
      DEFAULT_LIMITS.maxConcurrentPostsPerSession,
    maxConnections: options.maxConnections ?? DEFAULT_LIMITS.maxConnections,
    maxHeaderBytes: options.maxHeaderBytes ?? DEFAULT_LIMITS.maxHeaderBytes,
    maxHeaderCount: options.maxHeaderCount ?? DEFAULT_LIMITS.maxHeaderCount,
    headersTimeoutMs: options.headersTimeoutMs ?? DEFAULT_LIMITS.headersTimeoutMs,
    bodyTimeoutMs:
      options.bodyTimeoutMs ?? options.requestTimeoutMs ?? DEFAULT_LIMITS.bodyTimeoutMs,
    socketTimeoutMs: options.socketTimeoutMs ?? DEFAULT_LIMITS.socketTimeoutMs,
    keepAliveTimeoutMs:
      options.keepAliveTimeoutMs ?? DEFAULT_LIMITS.keepAliveTimeoutMs,
  };
  for (const [name, value] of Object.entries(limits)) positiveInteger(name, value);
  for (const name of [
    "sessionSweepIntervalMs",
    "headersTimeoutMs",
    "bodyTimeoutMs",
    "socketTimeoutMs",
    "keepAliveTimeoutMs",
  ] as const) {
    timerDelay(name, limits[name]);
  }
  if (limits.maxConcurrentPostsPerSession > limits.maxConcurrentPosts) {
    throw new RangeError(
      "maxConcurrentPostsPerSession must not exceed maxConcurrentPosts",
    );
  }
  return limits;
}

function validateRequestHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  allowedHosts: string[],
): boolean {
  const host = validateHostHeader(req.headers.host, allowedHosts);
  if (!host.ok) {
    closeWithError(req, res, 403, host.message);
    return false;
  }
  const origin = validateOriginHeader(req.headers.origin, allowedHosts);
  if (!origin.ok) {
    closeWithError(req, res, 403, origin.message);
    return false;
  }
  return true;
}

function declaredBodyLength(req: IncomingMessage): number | null {
  const header = req.headers["content-length"];
  if (header === undefined) return null;
  if (typeof header !== "string" || !/^\d+$/.test(header)) return Number.NaN;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : Number.NaN;
}

type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 408 | 413 | 415; message: string };

function readPostBody(
  req: IncomingMessage,
  limit: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ParsedBody> {
  const declaredLength = declaredBodyLength(req);
  if (Number.isNaN(declaredLength)) {
    return Promise.resolve({ ok: false, status: 400, message: "invalid Content-Length" });
  }
  if (declaredLength !== null && declaredLength > limit) {
    return Promise.resolve({ ok: false, status: 413, message: "request body too large" });
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      finish({ ok: false, status: 408, message: "request body timed out" });
    }, timeoutMs);
    timer.unref();
    const finish = (result: ParsedBody): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      signal?.removeEventListener("abort", onCancelled);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        finish({ ok: false, status: 413, message: "request body too large" });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => {
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
      } catch {
        finish({ ok: false, status: 400, message: "invalid JSON request body" });
      }
    };
    const onAborted = (): void => finish({ ok: false, status: 400, message: "request aborted" });
    const onError = (): void => finish({ ok: false, status: 400, message: "request body read failed" });
    const onCancelled = (): void => {
      finish({ ok: false, status: 400, message: "MCP session closed" });
      req.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
    if (signal?.aborted) onCancelled();
    else signal?.addEventListener("abort", onCancelled, { once: true });
  });
}

function hasUnexpectedBody(req: IncomingMessage): boolean {
  const length = declaredBodyLength(req);
  return req.headers["transfer-encoding"] !== undefined || (length !== null && length !== 0);
}

function isJsonContentType(req: IncomingMessage): boolean {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string") return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function hasUnsupportedContentEncoding(req: IncomingMessage): boolean {
  const contentEncoding = req.headers["content-encoding"];
  return (
    contentEncoding !== undefined &&
    (typeof contentEncoding !== "string" || contentEncoding.trim().toLowerCase() !== "identity")
  );
}

function isCancellationPostBody(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body];
  return (
    messages.length > 0 &&
    messages.every(
      (message) =>
        isJSONRPCNotification(message) &&
        message.method === "notifications/cancelled",
    )
  );
}

async function parsePostBody(
  req: IncomingMessage,
  limit: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ParsedBody> {
  const declaredLength = declaredBodyLength(req);
  if (Number.isNaN(declaredLength)) {
    return { ok: false, status: 400, message: "invalid Content-Length" };
  }
  if (declaredLength !== null && declaredLength > limit) {
    return { ok: false, status: 413, message: "request body too large" };
  }
  if (!isJsonContentType(req)) {
    return { ok: false, status: 415, message: "Content-Type must be application/json" };
  }
  if (hasUnsupportedContentEncoding(req)) {
    return { ok: false, status: 415, message: "Content-Encoding must be identity" };
  }
  return readPostBody(req, limit, timeoutMs, signal);
}

export async function serveHttp(
  options: HttpServerOptions = {},
  services?: AppServices,
): Promise<HttpServerHandle> {
  const appServices = services ?? defaultAppServices;
  const ownsServices = services === undefined;
  const host = normalizeIpv4BindHost(options.host ?? DEFAULT_HTTP_HOST);
  const listenHost = bindHttpHost(host);
  const requestedPort = options.port ?? DEFAULT_HTTP_PORT;
  const path = options.path ?? DEFAULT_HTTP_PATH;
  if (isWildcardHttpBindHost(host) && options.allowedHosts === undefined) {
    throw new Error("wildcard HTTP binding requires allowed hostnames");
  }
  const normalizedAllowedHosts = [
    ...(options.allowedHosts ?? (isLocalHost(host) ? LOCAL_HOSTS : [host])),
  ].map(canonicalHttpHostname);
  if (!host || !Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("invalid HTTP listen address");
  }
  if (canonicalHttpPath(path) === null) {
    throw new Error("invalid HTTP endpoint path");
  }
  if (
    normalizedAllowedHosts.length === 0 ||
    normalizedAllowedHosts.some((value) => value === null)
  ) {
    throw new Error("at least one allowed HTTP hostname is required");
  }
  const allowedHosts = normalizedAllowedHosts as string[];
  const limits = resolveLimits(options);

  const sessions = new HttpSessionRegistry<Session>(limits.maxSessions);
  let closing = false;
  const workAdmission = new HttpWorkAdmission(
    limits.maxConcurrentPosts,
    limits.maxConcurrentPostsPerSession,
  );
  const postAdmission = new HttpPostAdmission<Session>(
    limits.maxConcurrentPosts,
    limits.maxConcurrentPostsPerSession,
  );
  const controlPostAdmission = new HttpPostAdmission<Session["controlPosts"]>(
    limits.maxConcurrentPosts,
    limits.maxConcurrentPostsPerSession,
  );

  const stopSession = async (session: Session): Promise<void> => {
    session.abort.abort(new DOMException("MCP session closed", "AbortError"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.server.close();
  };

  const closeSession = (id: string, session: Session): Promise<void> =>
    sessions.close(id, session, stopSession);

  const reapExpiredSessions = (): Promise<void> =>
    sessions.reap(limits.sessionIdleTtlMs, stopSession);

  const withParsedPostBody = async (
    req: IncomingMessage,
    res: ServerResponse,
    work: (body: unknown) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> => {
    const body = await parsePostBody(
      req,
      limits.maxRequestBodyBytes,
      limits.bodyTimeoutMs,
      signal,
    );
    if (!body.ok) {
      closeWithError(req, res, body.status, body.message);
      return;
    }
    await work(body.value);
  };

  const withAdmittedPost = async (
    session: Session | undefined,
    req: IncomingMessage,
    res: ServerResponse,
    work: () => Promise<void>,
    saturatedWork?: (rejection: 429 | 503) => Promise<void>,
  ): Promise<void> => {
    const admission = postAdmission.tryAcquire(session);
    if (admission === 429 || admission === 503) {
      if (saturatedWork) {
        const controlAdmission = session
          ? controlPostAdmission.tryAcquire(session.controlPosts)
          : controlPostAdmission.tryAcquire();
        if (typeof controlAdmission === "object") {
          try {
            await saturatedWork(admission);
          } finally {
            controlAdmission.release();
          }
          return;
        }
      }
      if (admission === 429) {
        closeWithError(req, res, 429, "MCP session request limit reached", { "retry-after": "1" });
      } else {
        closeWithError(req, res, 503, "server request limit reached", { "retry-after": "1" });
      }
      return;
    }
    try {
      await work();
    } finally {
      admission.release();
    }
  };

  const handleExistingSession = async (
    id: string,
    session: Session,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
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
      await closeSession(id, session);
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === "POST") {
      await withAdmittedPost(
        session,
        req,
        res,
        () =>
          sessions.withActive(session, () =>
            withParsedPostBody(
              req,
              res,
              (body) => session.transport.handleRequest(req, res, body),
              session.abort.signal,
            ),
          ),
        (rejection) =>
          sessions.withActive(session, () =>
            withParsedPostBody(
              req,
              res,
              (body) => {
                if (isCancellationPostBody(body)) {
                  return session.transport.handleRequest(req, res, body);
                }
                if (rejection === 429) {
                  closeWithError(req, res, 429, "MCP session request limit reached", { "retry-after": "1" });
                } else {
                  closeWithError(req, res, 503, "server request limit reached", { "retry-after": "1" });
                }
                return Promise.resolve();
              },
              session.abort.signal,
            ),
          ),
      );
      return;
    }
    await sessions.withActive(session, () => session.transport.handleRequest(req, res));
  };

  const handleInitialization = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    if (req.method !== "POST") {
      closeWithError(req, res, 400, "MCP session initialization requires POST");
      return;
    }
    await withAdmittedPost(undefined, req, res, () =>
      withParsedPostBody(req, res, async (body) => {
        if (!isInitializeRequest(body)) {
          closeWithError(req, res, 400, "MCP session initialization required");
          return;
        }
        await reapExpiredSessions();
        if (closing) {
          closeWithError(req, res, 503, "server is shutting down", { "retry-after": "1" });
          return;
        }
        const reservation = sessions.tryReserve();
        if (!reservation) {
          closeWithError(req, res, 503, "MCP session limit reached", { "retry-after": "1" });
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
              appServices,
              workAdmission.forSession(abort.signal),
            ),
          );
          const session: Session = {
            server: mcp,
            transport,
            abort,
            lastUsedAt: Date.now(),
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
            await sessions.withActive(session, async () => {
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
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (closing) {
      closeWithError(req, res, 503, "server is shutting down", { "retry-after": "1" });
      return;
    }
    if (requestPath(req) !== path) {
      closeWithError(req, res, 404, "MCP endpoint not found");
      return;
    }
    if (!validateRequestHeaders(req, res, allowedHosts)) return;
    if (req.method !== "POST" && req.method !== "GET" && req.method !== "DELETE") {
      closeWithError(req, res, 405, "MCP method not allowed", { allow: "GET, POST, DELETE" });
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
      await handleInitialization(req, res);
      return;
    }
    const session = sessions.get(id);
    if (!session) {
      closeWithError(req, res, 404, "MCP session not found");
      return;
    }
    await handleExistingSession(id, session, req, res);
  };

  const headerTimers = new WeakMap<Socket, NodeJS.Timeout>();
  const connections = new Set<Socket>();
  const server = createServer(
    {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: 0,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: Math.min(
        1_000,
        limits.headersTimeoutMs,
        limits.bodyTimeoutMs,
      ),
    },
    (req, res) => {
      const headerTimer = headerTimers.get(req.socket);
      if (headerTimer) {
        clearTimeout(headerTimer);
        headerTimers.delete(req.socket);
      }
      req.socket.setTimeout(limits.socketTimeoutMs);
      void handle(req, res).catch((error: unknown) => {
        console.error("HTTP request failed", error);
        jsonError(res, 500, "internal server error");
      });
    },
  );
  const keepAliveTimeoutBuffer =
    "keepAliveTimeoutBuffer" in server &&
    typeof server.keepAliveTimeoutBuffer === "number"
      ? server.keepAliveTimeoutBuffer
      : 0;
  const maxKeepAliveTimeoutMs = MAX_TIMER_DELAY_MS - keepAliveTimeoutBuffer;
  if (limits.keepAliveTimeoutMs > maxKeepAliveTimeoutMs) {
    throw new RangeError(
      `keepAliveTimeoutMs must not exceed ${maxKeepAliveTimeoutMs} on this Node.js runtime`,
    );
  }
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.setTimeout(limits.headersTimeoutMs, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), limits.headersTimeoutMs);
    timer.unref();
    headerTimers.set(socket, timer);
    socket.once("close", () => {
      clearTimeout(timer);
      connections.delete(socket);
    });
  });
  server.maxConnections = limits.maxConnections;
  server.maxHeadersCount = limits.maxHeaderCount;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = 0;
  server.timeout = limits.socketTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  const lease = ownsServices ? acquireDefaultAppServices() : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once("error", onError);
      server.listen(requestedPort, listenHost, () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    await lease?.release();
    throw error;
  }
  server.on("error", (error) => console.error("HTTP server failed", error));
  const sessionSweep = setInterval(() => {
    void reapExpiredSessions();
  }, limits.sessionSweepIntervalMs);
  sessionSweep.unref();
  const address = server.address() as AddressInfo;
  const port = address.port;
  const displayHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  let shutdown: Promise<void> | undefined;

  return {
    host,
    port,
    path,
    url: `http://${displayHost}:${port}${path}`,
    sessionCount: () => sessions.size,
    close: () =>
      (shutdown ??= (async () => {
        closing = true;
        clearInterval(sessionSweep);
        await sessions.closeAll(stopSession);
        const closed = closeNodeServer(server);
        for (const socket of connections) socket.destroy();
        try {
          await closed;
        } finally {
          await lease?.release();
        }
      })()),
  };
}
