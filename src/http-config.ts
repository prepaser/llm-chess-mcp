import { isIP } from "node:net";
import type { BearerAuthOptions, HttpSecurityLimits } from "./http-security.js";
import type { HttpTlsOptions } from "./http-tls.js";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3_000;
export const DEFAULT_HTTP_PATH = "/mcp";
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type HttpServerOptions = {
  /** Cancels startup; use the returned handle to close a running server. */
  signal?: AbortSignal;
  host?: string;
  port?: number;
  path?: string;
  auth?: BearerAuthOptions;
  trustedProxies?: readonly string[];
  rateLimits?: HttpSecurityLimits;
  tls?: HttpTlsOptions;
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

export type HttpLimits = Required<
  Omit<HttpServerOptions, "host" | "port" | "path" | "requestTimeoutMs" | "auth" | "trustedProxies" | "rateLimits" | "tls" | "signal">
>;

export type ResolvedHttpConfig = {
  host: string;
  listenHost: string;
  port: number;
  path: string;
  tls: HttpTlsOptions;
  limits: HttpLimits;
};

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

export function bindHttpHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") && host.includes(":")
    ? host.slice(1, -1)
    : host;
}

export function canonicalHttpHostname(host: string): string | null {
  if (!host || host !== host.trim() || /[\\/?#@]/.test(host)) return null;
  const normalized = host.toLowerCase();
  const unwrapped = bindHttpHost(normalized);
  if (isIP(unwrapped) === 6) {
    return new URL(`http://[${unwrapped}]`).hostname;
  }
  if (/[\[\]:]/.test(normalized)) return null;
  try {
    const url = new URL(`http://${normalized}`);
    return url.username || url.password || url.port || !url.hostname
      ? null
      : url.hostname;
  } catch {
    return null;
  }
}

export function canonicalHttpPath(path: string): string | null {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return null;
  }
  try {
    return new URL(path, "http://localhost").pathname === path ? path : null;
  } catch {
    return null;
  }
}

export function isCanonicalHttpPath(path: string): boolean {
  return canonicalHttpPath(path) !== null;
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

export function resolveHttpConfig(options: HttpServerOptions): ResolvedHttpConfig {
  const host = canonicalHttpHostname(options.host ?? DEFAULT_HTTP_HOST);
  if (host === null) throw new Error("invalid HTTP bind host");
  const port = options.port ?? (options.tls && options.tls.mode !== "off" ? 443 : DEFAULT_HTTP_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("invalid HTTP listen address");
  }
  const path = options.path ?? DEFAULT_HTTP_PATH;
  if (canonicalHttpPath(path) === null) {
    throw new Error("invalid HTTP endpoint path");
  }
  const tls = resolveTlsOptions(options.tls, bindHttpHost(host), port);
  return {
    host,
    listenHost: bindHttpHost(host),
    port,
    path,
    tls,
    limits: resolveLimits(options),
  };
}

function resolveTlsOptions(
  options: HttpTlsOptions | undefined,
  listenHost: string,
  port: number,
): HttpTlsOptions {
  const tls = options ?? { mode: "off" as const };
  if (tls.mode === "acme") {
    const challengePort = tls.challengePort ?? 80;
    if (!Number.isInteger(challengePort) || challengePort < 0 || challengePort > 65_535) {
      throw new Error("invalid ACME challenge port");
    }
    validateHttpTlsPortCollision(port, tls);
    const challengeHost = tls.challengeHost === undefined
      ? listenHost
      : canonicalHttpHostname(tls.challengeHost);
    if (challengeHost === null) throw new Error("invalid ACME challenge host");
    return { ...tls, challengeHost: bindHttpHost(challengeHost), challengePort };
  }
  return tls;
}

/** Reject fixed listener configurations that cannot renew HTTP-01 safely. */
export function validateHttpTlsPortCollision(
  httpPort: number,
  tls: HttpTlsOptions | undefined,
): void {
  if (!tls || tls.mode !== "acme") return;
  const challengePort = tls.challengePort ?? 80;
  if (httpPort > 0 && challengePort > 0 && httpPort === challengePort) {
    throw new Error("HTTPS listen port and ACME challenge port must differ");
  }
}
