import { EXPLORER_ERROR_KINDS } from "./domain.js";
import type { ExplorerErrorKind, LichessMove } from "./domain.js";

export { EXPLORER_ERROR_KINDS };
export type { ExplorerErrorKind };

export const EXPLORER_ATTEMPT_TIMEOUT_MS = 5_000;
export const EXPLORER_MAX_ATTEMPTS = 2;
export const EXPLORER_DEFAULT_RETRY_DELAY_MS = 250;
export const EXPLORER_TOTAL_TIMEOUT_MS = 12_000;
export const EXPLORER_RATE_LIMIT_COOLDOWN_MS = 60_000;

export class ExplorerError extends Error {
  readonly reason: ExplorerErrorKind;

  constructor(
    readonly kind: ExplorerErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ExplorerError";
    this.reason = kind;
  }
}

const errorMessages: Record<ExplorerErrorKind, string> = {
  disabled: "Lichess opening explorer is disabled",
  invalid_input: "Invalid Lichess opening explorer filters",
  timeout: "Lichess opening explorer timed out",
  network: "Lichess opening explorer network failure",
  auth: "Lichess opening explorer authentication failed",
  rate_limited: "Lichess opening explorer rate limited the request",
  upstream: "Lichess opening explorer service failure",
  http: "Lichess opening explorer rejected the request",
  invalid_response: "Lichess opening explorer returned an invalid response",
};

export function explorerError(
  kind: ExplorerErrorKind,
  status?: number,
): ExplorerError {
  return new ExplorerError(kind, errorMessages[kind], status);
}

export interface ExplorerResult {
  db: string;
  white: number;
  draws: number;
  black: number;
  moves: LichessMove[];
  opening: { eco: string; name: string } | null;
}

export type ExplorerFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export async function awaitWithAbort<T>(
  signal: AbortSignal | undefined,
  start: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return start();

  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      start().then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (cause) => {
          cleanup();
          reject(cause);
        },
      );
    } catch (cause) {
      cleanup();
      reject(cause);
    }
  });
}
