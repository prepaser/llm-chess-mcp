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

const HTTP_DATE = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ \d]\d \d{2}:\d{2}:\d{2} \d{4})$/;

function parseRetryAfterMs(value: string, wallNow: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const delay = seconds * 1_000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  if (!HTTP_DATE.test(trimmed)) return;
  const delay = Date.parse(trimmed) - wallNow;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return EXPLORER_DEFAULT_RETRY_DELAY_MS;
  return parseRetryAfterMs(value, now) ?? EXPLORER_DEFAULT_RETRY_DELAY_MS;
}

export function rateLimitCooldownMs(value: string | null, now: number): number {
  if (value === null || value.trim() === "") {
    return EXPLORER_RATE_LIMIT_COOLDOWN_MS;
  }
  return parseRetryAfterMs(value, now) ?? EXPLORER_RATE_LIMIT_COOLDOWN_MS;
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
