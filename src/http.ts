import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/server";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
  originValidation,
} from "@modelcontextprotocol/node";
import { buildServer } from "./server.js";
import { HttpWorkAdmission } from "./http-work.js";
import type { WorkRunner } from "./http-work.js";
import { defaultAppServices } from "./services.js";
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
};

type HttpLimits = Required<Omit<HttpServerOptions, "host" | "port" | "path" | "allowedHosts">>;

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;
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
  requestTimeoutMs: 15_000,
  socketTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
};

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
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
  try {
    return new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
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

function resolveLimits(options: HttpServerOptions): HttpLimits {
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
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_LIMITS.requestTimeoutMs,
    socketTimeoutMs: options.socketTimeoutMs ?? DEFAULT_LIMITS.socketTimeoutMs,
    keepAliveTimeoutMs:
      options.keepAliveTimeoutMs ?? DEFAULT_LIMITS.keepAliveTimeoutMs,
  };
  for (const [name, value] of Object.entries(limits)) positiveInteger(name, value);
  if (limits.maxConcurrentPostsPerSession > limits.maxConcurrentPosts) {
    throw new RangeError(
      "maxConcurrentPostsPerSession must not exceed maxConcurrentPosts",
    );
  }
  return limits;
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
  | { ok: false; status: 400 | 408 | 413; message: string };

function readPostBody(
  req: IncomingMessage,
  limit: number,
  timeoutMs: number,
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
      req.destroy();
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
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("aborted", onAborted);
    req.once("error", onError);
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

const UNABORTABLE_SIGNAL = new AbortController().signal;

function scopedServices(services: AppServices, run: WorkRunner): AppServices {
  return {
    ...services,
    analyze: (fen, depth, multipv, request) =>
      run(request ?? UNABORTABLE_SIGNAL, (signal) =>
        services.analyze(fen, depth, multipv, signal),
      ),
    humanMoveDistribution: (chess, elo, opponentElo, topN, request) =>
      run(request ?? UNABORTABLE_SIGNAL, (signal) =>
        services.humanMoveDistribution(chess, elo, opponentElo, topN, signal),
      ),
    openingExplorer: (chess, db, speeds, ratings, request) =>
      run(request ?? UNABORTABLE_SIGNAL, (signal) =>
        services.openingExplorer(chess, db, speeds, ratings, signal),
      ),
    computeCandidates: (
      chess,
      elo,
      sfDepth,
      sfMultipv,
      maiaTopN,
      lichess,
      request,
    ) =>
      run(request ?? UNABORTABLE_SIGNAL, (signal) =>
        services.computeCandidates(
          chess,
          elo,
          sfDepth,
          sfMultipv,
          maiaTopN,
          lichess,
          signal,
        ),
      ),
  };
}

export async function serveHttp(
  options: HttpServerOptions = {},
  services: AppServices = defaultAppServices,
): Promise<HttpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3_000;
  const path = options.path ?? "/mcp";
  const wildcard = host === "0.0.0.0" || host === "::" || host === "[::]";
  if (wildcard && options.allowedHosts === undefined) {
    throw new Error("wildcard HTTP binding requires allowed hostnames");
  }
  const allowedHosts = [
    ...(options.allowedHosts ?? (isLocalHost(host) ? LOCAL_HOSTS : [host])),
  ];
  if (!host || !Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error("invalid HTTP listen address");
  }
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new Error("invalid HTTP endpoint path");
  }
  if (allowedHosts.length === 0 || allowedHosts.some((value) => !value)) {
    throw new Error("at least one allowed HTTP hostname is required");
  }
  const limits = resolveLimits(options);

  const sessions = new Map<string, Session>();
  const initializing = new Set<Session>();
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedHosts);
  let closing = false;
  let pendingInitializations = 0;
  let activePosts = 0;
  const workAdmission = new HttpWorkAdmission(
    limits.maxConcurrentPosts,
    limits.maxConcurrentPostsPerSession,
  );

  const stopSession = async (session: Session): Promise<void> => {
    session.abort.abort(new DOMException("MCP session closed", "AbortError"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await session.server.close();
  };

  const closeSession = async (id: string, session: Session): Promise<void> => {
    if (sessions.get(id) !== session) return;
    sessions.delete(id);
    await stopSession(session);
  };

  const reapExpiredSessions = async (): Promise<void> => {
    const now = Date.now();
    await Promise.allSettled(
      [...sessions.entries()]
        .filter(
          ([, session]) =>
            session.activeRequests === 0 && now - session.lastUsedAt >= limits.sessionIdleTtlMs,
        )
        .map(([id, session]) => closeSession(id, session)),
    );
  };

  const releasePost = (session: Session | undefined): void => {
    activePosts -= 1;
    if (session) session.activePosts -= 1;
  };

  const acquirePost = (session: Session | undefined): 429 | 503 | undefined => {
    if (session && session.activePosts >= limits.maxConcurrentPostsPerSession) return 429;
    if (activePosts >= limits.maxConcurrentPosts) return 503;
    activePosts += 1;
    if (session) session.activePosts += 1;
    return undefined;
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
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

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
    if (id !== undefined) {
      const session = sessions.get(id);
      if (!session) {
        closeWithError(req, res, 404, "MCP session not found");
        return;
      }
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
        const rejected = acquirePost(session);
        if (rejected === 429) {
          closeWithError(req, res, 429, "MCP session request limit reached", { "retry-after": "1" });
          return;
        }
        if (rejected === 503) {
          closeWithError(req, res, 503, "server request limit reached", { "retry-after": "1" });
          return;
        }
        session.activeRequests += 1;
        session.lastUsedAt = Date.now();
        try {
          const body = await readPostBody(
            req,
            limits.maxRequestBodyBytes,
            limits.requestTimeoutMs,
          );
          if (!body.ok) {
            closeWithError(req, res, body.status, body.message);
            return;
          }
          if (!isJsonContentType(req)) {
            closeWithError(req, res, 415, "Content-Type must be application/json");
            return;
          }
          if (hasUnsupportedContentEncoding(req)) {
            closeWithError(req, res, 415, "Content-Encoding must be identity");
            return;
          }
          await session.transport.handleRequest(req, res, body.value);
        } finally {
          session.activeRequests -= 1;
          session.lastUsedAt = Date.now();
          releasePost(session);
        }
        return;
      }
      session.lastUsedAt = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method !== "POST") {
      closeWithError(req, res, 400, "MCP session initialization requires POST");
      return;
    }
    const rejected = acquirePost(undefined);
    if (rejected === 503) {
      closeWithError(req, res, 503, "server request limit reached", { "retry-after": "1" });
      return;
    }
    const body = await readPostBody(
      req,
      limits.maxRequestBodyBytes,
      limits.requestTimeoutMs,
    );
    if (!body.ok) {
      releasePost(undefined);
      closeWithError(req, res, body.status, body.message);
      return;
    }
    if (!isJsonContentType(req)) {
      releasePost(undefined);
      closeWithError(req, res, 415, "Content-Type must be application/json");
      return;
    }
    if (hasUnsupportedContentEncoding(req)) {
      releasePost(undefined);
      closeWithError(req, res, 415, "Content-Encoding must be identity");
      return;
    }
    if (!isInitializeRequest(body.value)) {
      releasePost(undefined);
      closeWithError(req, res, 400, "MCP session initialization required");
      return;
    }
    await reapExpiredSessions();
    if (closing) {
      releasePost(undefined);
      closeWithError(req, res, 503, "server is shutting down", { "retry-after": "1" });
      return;
    }
    if (sessions.size + pendingInitializations >= limits.maxSessions) {
      releasePost(undefined);
      closeWithError(req, res, 503, "MCP session limit reached", { "retry-after": "1" });
      return;
    }
    pendingInitializations += 1;

    let initializedId: string | undefined;
    let session: Session;
    let hasReservation = true;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (newId) => {
        initializedId = newId;
        initializing.delete(session);
        if (hasReservation) {
          hasReservation = false;
          pendingInitializations -= 1;
        }
        session.lastUsedAt = Date.now();
        sessions.set(newId, session);
      },
      onsessionclosed: (closedId) => {
        const current = sessions.get(closedId);
        if (current === session) sessions.delete(closedId);
      },
    });
    const abort = new AbortController();
    const mcp = buildServer(
      scopedServices(services, workAdmission.session(abort.signal)),
    );
    session = {
      server: mcp,
      transport,
      abort,
      lastUsedAt: Date.now(),
      activeRequests: 1,
      activePosts: 0,
    };
    initializing.add(session);
    transport.onclose = () => {
      session.abort.abort(new DOMException("MCP session closed", "AbortError"));
      if (initializedId && sessions.get(initializedId) === session) {
        sessions.delete(initializedId);
      }
    };
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body.value);
    } finally {
      session.activeRequests -= 1;
      session.lastUsedAt = Date.now();
      initializing.delete(session);
      releasePost(undefined);
      if (hasReservation) pendingInitializations -= 1;
      if (!initializedId) await mcp.close();
    }
  };

  const headerTimers = new WeakMap<Socket, NodeJS.Timeout>();
  const server = createServer(
    {
      maxHeaderSize: limits.maxHeaderBytes,
      headersTimeout: limits.headersTimeoutMs,
      requestTimeout: limits.requestTimeoutMs,
      keepAliveTimeout: limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: Math.min(
        1_000,
        limits.headersTimeoutMs,
        limits.requestTimeoutMs,
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
  server.on("connection", (socket) => {
    socket.setTimeout(limits.headersTimeoutMs, () => socket.destroy());
    const timer = setTimeout(() => socket.destroy(), limits.headersTimeoutMs);
    timer.unref();
    headerTimers.set(socket, timer);
    socket.once("close", () => clearTimeout(timer));
  });
  server.maxConnections = limits.maxConnections;
  server.maxHeadersCount = limits.maxHeaderCount;
  server.headersTimeout = limits.headersTimeoutMs;
  server.requestTimeout = limits.requestTimeoutMs;
  server.timeout = limits.socketTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
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
        const pending = [...initializing];
        initializing.clear();
        await Promise.allSettled(
          [
            ...[...sessions.entries()].map(([id, session]) => closeSession(id, session)),
            ...pending.map(stopSession),
          ],
        );
        await closeNodeServer(server);
      })()),
  };
}
