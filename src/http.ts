import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  MAX_TIMER_DELAY_MS,
  resolveHttpConfig,
} from "./http-config.js";
import type { HttpServerOptions } from "./http-config.js";
import { HttpRuntime } from "./http-runtime.js";
import { jsonError } from "./http-response.js";
import { failAfterCleanup, orderedTeardown } from "./lifecycle.js";
import { acquireDefaultAppServices, defaultAppServices } from "./services.js";
import type { AppServices, DefaultAppServicesLease } from "./services.js";

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
  const config = resolveHttpConfig(options);
  const appServices = services ?? defaultAppServices;
  const runtime = new HttpRuntime(
    appServices,
    config.path,
    config.allowedHosts,
    config.limits,
  );
  const headerTimers = new WeakMap<Socket, NodeJS.Timeout>();
  const connections = new Set<Socket>();
  const server = createServer(
    {
      maxHeaderSize: config.limits.maxHeaderBytes,
      headersTimeout: config.limits.headersTimeoutMs,
      requestTimeout: 0,
      keepAliveTimeout: config.limits.keepAliveTimeoutMs,
      connectionsCheckingInterval: Math.min(
        1_000,
        config.limits.headersTimeoutMs,
        config.limits.bodyTimeoutMs,
      ),
    },
    (req: IncomingMessage, res: ServerResponse) => {
      const headerTimer = headerTimers.get(req.socket);
      if (headerTimer) {
        clearTimeout(headerTimer);
        headerTimers.delete(req.socket);
      }
      req.socket.setTimeout(config.limits.socketTimeoutMs);
      void runtime.handle(req, res).catch((error: unknown) => {
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
  if (config.limits.keepAliveTimeoutMs > maxKeepAliveTimeoutMs) {
    throw new RangeError(
      `keepAliveTimeoutMs must not exceed ${maxKeepAliveTimeoutMs} on this Node.js runtime`,
    );
  }
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.setTimeout(config.limits.headersTimeoutMs, () => socket.destroy());
    const timer = setTimeout(
      () => socket.destroy(),
      config.limits.headersTimeoutMs,
    );
    timer.unref();
    headerTimers.set(socket, timer);
    socket.once("close", () => {
      clearTimeout(timer);
      connections.delete(socket);
    });
  });
  server.maxConnections = config.limits.maxConnections;
  server.maxHeadersCount = config.limits.maxHeaderCount;
  server.headersTimeout = config.limits.headersTimeoutMs;
  server.requestTimeout = 0;
  server.timeout = config.limits.socketTimeoutMs;
  server.keepAliveTimeout = config.limits.keepAliveTimeoutMs;

  const lease = services === undefined ? acquireDefaultAppServices() : undefined;
  try {
    await listen(server, config.port, config.listenHost);
  } catch (error) {
    return failAfterCleanup(
      error,
      () => release(lease),
      "HTTP server startup and service release failed",
    );
  }
  server.on("error", (error) => console.error("HTTP server failed", error));
  runtime.start();

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
    url: `http://${displayHost}:${port}${config.path}`,
    sessionCount: () => runtime.sessionCount,
    close: () =>
      (shutdown ??= orderedTeardown(
        [
          () => runtime.close(),
          () => closeListener(server, connections),
          () => release(lease),
        ],
        "HTTP server shutdown failed",
      )),
  };
}
