import type { IncomingMessage, ServerResponse } from "node:http";

export function jsonError(
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

export function closeWithError(
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
