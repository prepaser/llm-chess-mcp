import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
  originValidation,
} from "@modelcontextprotocol/node";
import { buildServer } from "./server.js";
import { defaultAppServices } from "./services.js";
import type { AppServices } from "./services.js";

export type HttpServerOptions = {
  host?: string;
  port?: number;
  path?: string;
  allowedHosts?: readonly string[];
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
};

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function jsonError(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy(new Error(message));
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32_000, message },
      id: null,
    }),
  );
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

  const sessions = new Map<string, Session>();
  const validateHost = hostHeaderValidation(allowedHosts);
  const validateOrigin = originValidation(allowedHosts);
  let closing = false;

  const closeSession = async (id: string, session: Session): Promise<void> => {
    if (sessions.get(id) !== session) return;
    sessions.delete(id);
    await session.server.close();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (closing) {
      jsonError(res, 503, "server is shutting down");
      return;
    }
    if (requestPath(req) !== path) {
      jsonError(res, 404, "MCP endpoint not found");
      return;
    }
    if (!validateHost(req, res) || !validateOrigin(req, res)) return;

    const id = sessionId(req);
    if (id === null) {
      jsonError(res, 400, "invalid MCP session ID");
      return;
    }
    if (id !== undefined) {
      const session = sessions.get(id);
      if (!session) {
        jsonError(res, 404, "MCP session not found");
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    let initializedId: string | undefined;
    let session: Session;
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (newId) => {
        initializedId = newId;
        sessions.set(newId, session);
      },
      onsessionclosed: (closedId) => {
        const current = sessions.get(closedId);
        if (current) void closeSession(closedId, current);
      },
    });
    const mcp = buildServer(services);
    session = { server: mcp, transport };
    transport.onclose = () => {
      if (initializedId && sessions.get(initializedId) === session) {
        sessions.delete(initializedId);
      }
    };
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
    } finally {
      if (!initializedId) await mcp.close();
    }
  };

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      console.error("HTTP request failed", error);
      jsonError(res, 500, "internal server error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(requestedPort, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => console.error("HTTP server failed", error));
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
        await Promise.allSettled(
          [...sessions.entries()].map(([id, session]) => closeSession(id, session)),
        );
        await closeNodeServer(server);
      })()),
  };
}
