import {
  awaitWithAbort,
  explorerError,
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  throwIfAborted,
} from "./explorer-core.js";
import type { ExplorerError, ExplorerFetch } from "./explorer-core.js";

export interface ExplorerTransportOptions {
  callerSignal: AbortSignal | undefined;
  deadline: number;
  now: () => number;
  onLateResponse: (response: Response) => void;
  request: ExplorerFetch;
  timeout: (ms: number) => AbortSignal;
  token: string;
  url: string;
}

export type ExplorerTransportResult =
  | {
      type: "success";
      response: Response;
      signal: AbortSignal;
      cleanupSignal: AbortSignal;
    }
  | {
      type: "failure";
      error: ExplorerError;
      retryAfter: string | null;
      retryAfterReceivedAt: number | null;
    };

async function discardResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const body = response.body;
    if (!body) return;
    const cancellation = body.cancel();
    void cancellation.catch(() => {});
    await awaitWithAbort(signal, () => cancellation);
  } catch {}
}

function errorKindForStatus(status: number): ExplorerError["kind"] {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status >= 500 && status <= 599) return "upstream";
  return "http";
}

export async function requestExplorerTransport(
  options: ExplorerTransportOptions,
): Promise<ExplorerTransportResult> {
  const {
    callerSignal,
    deadline,
    now,
    onLateResponse,
    request,
    timeout,
    token,
    url,
  } = options;
  throwIfAborted(callerSignal);
  const remaining = deadline - now();
  if (remaining <= 0) throw explorerError("timeout");
  const attemptSignal = timeout(
    Math.max(
      1,
      Math.floor(Math.min(EXPLORER_ATTEMPT_TIMEOUT_MS, remaining)),
    ),
  );
  const signal = AbortSignal.any(
    callerSignal ? [callerSignal, attemptSignal] : [attemptSignal],
  );

  let response: Response;
  let pending: Promise<Response> | undefined;
  try {
    pending = Promise.resolve(request(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    }));
    response = await awaitWithAbort(signal, () => pending!);
  } catch {
    if (signal.aborted && pending) {
      void pending
        .then((lateResponse) => {
          try {
            onLateResponse(lateResponse);
          } catch {}
          return discardResponse(lateResponse, attemptSignal);
        })
        .catch(() => {});
    }
    throwIfAborted(callerSignal);
    return {
      type: "failure",
      error: explorerError(signal.aborted ? "timeout" : "network"),
      retryAfter: null,
      retryAfterReceivedAt: null,
    };
  }

  if (callerSignal?.aborted) {
    await discardResponse(response, attemptSignal);
    throwIfAborted(callerSignal);
  }
  if (response.ok) {
    return { type: "success", response, signal, cleanupSignal: attemptSignal };
  }

  const kind = errorKindForStatus(response.status);
  const retryAfter = response.headers.get("retry-after");
  let retryAfterReceivedAt: number | null = null;
  if (kind === "rate_limited" || kind === "upstream") {
    try {
      retryAfterReceivedAt = now();
    } catch (cause) {
      await discardResponse(response, attemptSignal);
      throwIfAborted(callerSignal);
      throw cause;
    }
  }
  await discardResponse(response, attemptSignal);
  throwIfAborted(callerSignal);
  return {
    type: "failure",
    error: explorerError(kind, response.status),
    retryAfter,
    retryAfterReceivedAt,
  };
}
