import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Server as HttpsServer } from "node:https";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  MAX_TIMER_DELAY_MS,
  resolveHttpConfig,
  validateHttpTlsPortCollision,
} from "./http-config.js";
import type { HttpServerOptions } from "./http-config.js";
import { HttpRuntime } from "./http-runtime.js";
import { jsonError } from "./http-response.js";
import { failAfterCleanup, orderedTeardown } from "./lifecycle.js";
import { acquireDefaultAppServices, defaultAppServices } from "./services.js";
import type { AppServices, DefaultAppServicesLease } from "./services.js";
import { canonicalClientIpKey, HttpSecurity, loadBearerAuthenticator, TrustedProxySet } from "./http-security.js";
import { prepareHttpTls } from "./http-tls.js";

export type { HttpServerOptions } from "./http-config.js";

export type HttpServerHandle = {
  host: string;
  port: number;
  path: string;
  url: string;
  sessionCount(): number;
  close(): Promise<void>;
};

function closeNodeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeListener(server: Server, connections: Set<Socket>): Promise<void> {
  const closed = closeNodeServer(server);
  for (const socket of connections) socket.destroy();
  return closed;
}

function release(lease: DefaultAppServicesLease | undefined): Promise<void> {
  return lease?.release() ?? Promise.resolve();
}

export async function serveHttp(
  options: HttpServerOptions = {},
  services?: AppServices,
): Promise<HttpServerHandle> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const config = resolveHttpConfig(options);
  const appServices = services ?? defaultAppServices;
  const auth = await loadBearerAuthenticator(options.auth);
  const security = new HttpSecurity(options.rateLimits);
  const proxies = new TrustedProxySet(options.trustedProxies);
  const runtime = new HttpRuntime(
    appServices,
    config.path,
    config.limits,
    security,
    auth,
    proxies,
  );
  const tls = await prepareHttpTls(config.tls);
  const cancelStartup = (): void => { void tls.close().catch(() => {}); };
  signal?.addEventListener("abort", cancelStartup, { once: true });
  try {
    try {
      signal?.throwIfAborted();
      await tls.start();
      signal?.throwIfAborted();
    } catch (error) {
      const failure = signal?.aborted && !(error instanceof AggregateError) ? signal.reason : error;
      return failAfterCleanup(failure, () => tls.close(), "TLS startup and cleanup failed");
    }
    const headerTimers = new WeakMap<Socket, NodeJS.Timeout>();
    const connections = new Set<Socket>();
    const serverOptions = {
        maxHeaderSize: config.limits.maxHeaderBytes,
        headersTimeout: config.limits.headersTimeoutMs,
        requestTimeout: 0,
        keepAliveTimeout: config.limits.keepAliveTimeoutMs,
        connectionsCheckingInterval: Math.min(
          1_000,
          config.limits.headersTimeoutMs,
          config.limits.bodyTimeoutMs,
        ),
      };
    const handler = (req: IncomingMessage, res: ServerResponse): void => {
        const headerTimer = headerTimers.get(req.socket);
        if (headerTimer) {
          clearTimeout(headerTimer);
          headerTimers.delete(req.socket);
        }
        req.socket.setTimeout(config.limits.socketTimeoutMs);
        if (!tls.isAvailable()) {
          req.socket.destroy();
          return;
        }
        void runtime.handle(req, res).catch((error: unknown) => {
          console.error("HTTP request failed", error);
          jsonError(res, 500, "internal server error");
        });
      };
    let server: Server;
    try {
      server = tls.mode === "off"
        ? createServer(serverOptions, handler)
        : createHttpsServer({ ...serverOptions, ...tls.getServerOptions(), minVersion: "TLSv1.2", handshakeTimeout: config.limits.headersTimeoutMs }, handler);
    } catch (error) {
      return failAfterCleanup(error, () => tls.close(), "HTTP listener creation and TLS cleanup failed");
    }
    tls.onSecureContext((context) => (server as HttpsServer).setSecureContext(context));
    tls.onAvailability((available) => {
      if (!available) for (const socket of connections) socket.destroy();
    });
    const keepAliveTimeoutBuffer =
      "keepAliveTimeoutBuffer" in server &&
      typeof server.keepAliveTimeoutBuffer === "number"
        ? server.keepAliveTimeoutBuffer
        : 0;
    const maxKeepAliveTimeoutMs = MAX_TIMER_DELAY_MS - keepAliveTimeoutBuffer;
    if (config.limits.keepAliveTimeoutMs > maxKeepAliveTimeoutMs) {
      await tls.close();
      throw new RangeError(
        `keepAliveTimeoutMs must not exceed ${maxKeepAliveTimeoutMs} on this Node.js runtime`,
      );
    }
    const startHeaderTimer = (socket: Socket): void => {
      socket.setTimeout(config.limits.headersTimeoutMs, () => socket.destroy());
      const timer = setTimeout(
        () => socket.destroy(),
        config.limits.headersTimeoutMs,
      );
      timer.unref();
      headerTimers.set(socket, timer);
      socket.once("close", () => {
        clearTimeout(timer);
      });
    };
    server.on("connection", (socket) => {
      if (!tls.isAvailable()) {
        socket.destroy();
        return;
      }
      const ip = canonicalClientIpKey(socket.remoteAddress ?? "");
      if (!ip) {
        socket.destroy();
        return;
      }
      const quota = security.acquire("connection", { ip });
      if (!("release" in quota)) {
        socket.destroy();
        return;
      }
      connections.add(socket);
      socket.once("close", () => {
        quota.release();
        connections.delete(socket);
      });
      if (tls.mode === "off") startHeaderTimer(socket);
    });
    if (tls.mode !== "off") server.on("secureConnection", startHeaderTimer);
    server.maxConnections = config.limits.maxConnections;
    server.maxHeadersCount = config.limits.maxHeaderCount;
    server.headersTimeout = config.limits.headersTimeoutMs;
    server.requestTimeout = 0;
    server.timeout = config.limits.socketTimeoutMs;
    server.keepAliveTimeout = config.limits.keepAliveTimeoutMs;

    const lease = services === undefined ? acquireDefaultAppServices() : undefined;
    try {
      await listen(server, config.port, config.listenHost);
      signal?.throwIfAborted();
      validateHttpTlsPortCollision((server.address() as AddressInfo).port, config.tls);
    } catch (error) {
      return failAfterCleanup(
        error,
        () => orderedTeardown([
          () => runtime.close(),
          () => server.listening ? closeListener(server, connections) : Promise.resolve(),
          () => tls.close(),
          () => release(lease),
        ], "HTTP startup cleanup failed"),
        "HTTP server startup and service release failed",
      );
    }
    server.on("error", (error) => console.error("HTTP server failed", error));
    runtime.start();
    if (auth.enabled && tls.mode === "off") console.error("warning: HTTP Bearer authentication is enabled without TLS; use a trusted TLS-terminating proxy");

    const address = server.address() as AddressInfo;
    const port = address.port;
    const displayHost =
      config.host.includes(":") && !config.host.startsWith("[")
        ? `[${config.host}]`
        : config.host;
    let shutdown: Promise<void> | undefined;
    return {
      host: config.host,
      port,
      path: config.path,
      url: `${tls.mode === "off" ? "http" : "https"}://${displayHost}:${port}${config.path}`,
      sessionCount: () => runtime.sessionCount,
      close: () =>
        (shutdown ??= orderedTeardown(
          [
            () => runtime.close(),
            () => closeListener(server, connections),
            () => tls.close(),
            () => release(lease),
          ],
          "HTTP server shutdown failed",
        )),
    };
  } finally {
    signal?.removeEventListener("abort", cancelStartup);
  }
}
