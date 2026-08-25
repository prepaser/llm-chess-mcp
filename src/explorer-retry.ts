import {
  awaitWithAbort,
  explorerError,
  EXPLORER_DEFAULT_RETRY_DELAY_MS,
  EXPLORER_RATE_LIMIT_COOLDOWN_MS,
} from "./explorer-core.js";
import type { ExplorerError } from "./explorer-core.js";

export type ExplorerRetryOutcome<T> =
  | { type: "success"; result: T }
  | {
      type: "failure";
      error: ExplorerError;
      retry: "stop" | "backoff" | "limiter";
      delay?: number;
    };

export interface ExplorerRetryOptions {
  callerSignal: AbortSignal | undefined;
  deadline: number;
  maxAttempts: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return EXPLORER_DEFAULT_RETRY_DELAY_MS;

  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay)) return EXPLORER_DEFAULT_RETRY_DELAY_MS;
  return Math.max(0, delay);
}

export function rateLimitCooldownMs(value: string | null, now: number): number {
  return value === null || value.trim() === ""
    ? EXPLORER_RATE_LIMIT_COOLDOWN_MS
    : retryAfterMs(value, now);
}

async function waitForRetry(
  options: ExplorerRetryOptions,
  delay: number,
  originalError: ExplorerError,
): Promise<void> {
  if (delay >= options.deadline - options.now()) throw originalError;
  await awaitWithAbort(options.callerSignal, () => options.sleep(delay));
  if (options.deadline - options.now() <= 0) throw originalError;
}

export async function retryExplorer<T>(
  options: ExplorerRetryOptions,
  attemptRequest: () => Promise<ExplorerRetryOutcome<T>>,
): Promise<T> {
  let lastError: ExplorerError | undefined;
  for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
    const outcome = await attemptRequest();
    if (outcome.type === "success") return outcome.result;

    lastError = outcome.error;
    if (outcome.retry === "stop" || attempt + 1 >= options.maxAttempts) {
      throw lastError;
    }
    if (
      outcome.retry === "limiter" &&
      (outcome.delay ?? 0) >= options.deadline - options.now()
    ) {
      throw lastError;
    }
    if (outcome.retry === "backoff") {
      await waitForRetry(
        options,
        outcome.delay ?? EXPLORER_DEFAULT_RETRY_DELAY_MS,
        lastError,
      );
    }
  }

  throw lastError ?? explorerError("network");
}
