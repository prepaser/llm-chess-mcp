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

const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LONG_WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const IMF_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE = /^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ ]?(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function httpDate(
  weekday: number,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCDay() !== weekday
  ) {
    return;
  }
  return date.getTime();
}

function parseHttpDate(value: string, wallNow: number): number | undefined {
  const imf = IMF_DATE.exec(value);
  if (imf) {
    return httpDate(
      SHORT_WEEKDAYS.indexOf(imf[1]!),
      Number(imf[4]),
      MONTHS.indexOf(imf[3]!),
      Number(imf[2]),
      Number(imf[5]),
      Number(imf[6]),
      Number(imf[7]),
    );
  }
  const rfc850 = RFC850_DATE.exec(value);
  if (rfc850) {
    const current = new Date(wallNow);
    const currentYear = current.getUTCFullYear();
    let year = 2000 + Number(rfc850[4]);
    const parts = [
      MONTHS.indexOf(rfc850[3]!),
      Number(rfc850[2]),
      Number(rfc850[5]),
      Number(rfc850[6]),
      Number(rfc850[7]),
    ];
    const currentParts = [
      current.getUTCMonth(),
      current.getUTCDate(),
      current.getUTCHours(),
      current.getUTCMinutes(),
      current.getUTCSeconds(),
    ];
    const laterInYear = parts.some(
      (part, index) =>
        part > currentParts[index]! &&
        parts.slice(0, index).every((value, prior) => value === currentParts[prior]),
    );
    if (year - currentYear > 50 || (year - currentYear === 50 && laterInYear)) {
      year -= 100;
    }
    return httpDate(
      LONG_WEEKDAYS.indexOf(rfc850[1]!),
      year,
      parts[0]!,
      parts[1]!,
      parts[2]!,
      parts[3]!,
      parts[4]!,
    );
  }
  const asctime = ASCTIME_DATE.exec(value);
  if (!asctime) return;
  return httpDate(
    SHORT_WEEKDAYS.indexOf(asctime[1]!),
    Number(asctime[7]),
    MONTHS.indexOf(asctime[2]!),
    Number(asctime[3]),
    Number(asctime[4]),
    Number(asctime[5]),
    Number(asctime[6]),
  );
}

function parseRetryAfterMs(value: string, wallNow: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    const delay = seconds * 1_000;
    return Number.isSafeInteger(delay) ? delay : undefined;
  }
  const timestamp = parseHttpDate(trimmed, wallNow);
  if (timestamp === undefined) return;
  const delay = timestamp - wallNow;
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
