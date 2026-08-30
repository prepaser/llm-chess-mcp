import type { IncomingMessage } from "node:http";
import { isJSONRPCNotification } from "@modelcontextprotocol/server";

export const MAX_CANCELLATION_PROBE_BYTES = 8 * 1024;

export type ParsedBody =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 408 | 413 | 415; message: string };

function declaredBodyLength(req: IncomingMessage): number | null {
  const header = req.headers["content-length"];
  if (header === undefined) return null;
  if (typeof header !== "string" || !/^\d+$/.test(header)) return Number.NaN;
  const length = Number(header);
  return Number.isSafeInteger(length) ? length : Number.NaN;
}

function readPostBody(
  req: IncomingMessage,
  limit: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ParsedBody> {
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
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        finish({ ok: true, value: JSON.parse(text) });
      } catch {
        finish({ ok: false, status: 400, message: "invalid JSON request body" });
      }
    };
    const onAborted = (): void =>
      finish({ ok: false, status: 400, message: "request aborted" });
    const onError = (): void =>
      finish({ ok: false, status: 400, message: "request body read failed" });
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

export async function parsePostBody(
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

export function hasUnexpectedBody(req: IncomingMessage): boolean {
  const length = declaredBodyLength(req);
  return req.headers["transfer-encoding"] !== undefined || (length !== null && length !== 0);
}

export function isCancellationPostBody(body: unknown): boolean {
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
