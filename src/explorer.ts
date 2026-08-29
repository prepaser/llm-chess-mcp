import { Chess } from "chess.js";
import { z } from "zod/v4";
import {
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  EXPLORER_DEFAULT_RETRY_DELAY_MS,
  EXPLORER_ERROR_KINDS,
  EXPLORER_MAX_ATTEMPTS,
  EXPLORER_MAX_COOLDOWN_MS,
  EXPLORER_MAX_MOVES,
  EXPLORER_MAX_RESPONSE_BYTES,
  EXPLORER_MAX_STRING_LENGTH,
  EXPLORER_RATE_LIMIT_COOLDOWN_MS,
  EXPLORER_TOTAL_TIMEOUT_MS,
  ExplorerError,
  explorerError,
  throwIfAborted,
} from "./explorer-core.js";
import type {
  ExplorerErrorKind,
  ExplorerFetch,
  ExplorerResult,
} from "./explorer-core.js";
import { createExplorerLimiter } from "./explorer-limiter.js";
import type {
  ExplorerLimiter,
  ExplorerLimiterOptions,
} from "./explorer-limiter.js";
import { normalizeExplorerResponse } from "./explorer-response.js";
import {
  rateLimitCooldownMs,
  retryAfterMs,
  retryExplorer,
} from "./explorer-retry.js";
import type { ExplorerRetryOutcome } from "./explorer-retry.js";
import { requestExplorerTransport } from "./explorer-transport.js";

const BASE = "https://explorer.lichess.org";

export {
  EXPLORER_ATTEMPT_TIMEOUT_MS,
  EXPLORER_DEFAULT_RETRY_DELAY_MS,
  EXPLORER_ERROR_KINDS,
  EXPLORER_MAX_ATTEMPTS,
  EXPLORER_MAX_COOLDOWN_MS,
  EXPLORER_MAX_MOVES,
  EXPLORER_MAX_RESPONSE_BYTES,
  EXPLORER_MAX_STRING_LENGTH,
  EXPLORER_RATE_LIMIT_COOLDOWN_MS,
  EXPLORER_TOTAL_TIMEOUT_MS,
  ExplorerError,
  createExplorerLimiter,
};
export type {
  ExplorerErrorKind,
  ExplorerFetch,
  ExplorerLimiter,
  ExplorerLimiterOptions,
  ExplorerResult,
};

export const LICHESS_SPEEDS = [
  "ultraBullet",
  "bullet",
  "blitz",
  "rapid",
  "classical",
  "correspondence",
] as const;

export const LICHESS_RATINGS = [
  0, 1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500,
] as const;

export type LichessSpeed = (typeof LICHESS_SPEEDS)[number];
export type LichessRating = (typeof LICHESS_RATINGS)[number];

export const lichessSpeedSchema = z.enum(LICHESS_SPEEDS);
export const lichessRatingSchema = z.union([
  z.literal(0),
  z.literal(1000),
  z.literal(1200),
  z.literal(1400),
  z.literal(1600),
  z.literal(1800),
  z.literal(2000),
  z.literal(2200),
  z.literal(2500),
]);

export interface ExplorerRequestOptions {
  fetch?: ExplorerFetch;
  limiter?: ExplorerLimiter;
  sleep?: (ms: number) => Promise<void>;
  timeout?: (ms: number) => AbortSignal;
  signal?: AbortSignal;
  now?: () => number;
  wallNow?: () => number;
  token?: string;
}

const speedSet = new Set<string>(LICHESS_SPEEDS);
const ratingSet = new Set<number>(LICHESS_RATINGS);
const dbSet = new Set<string>(["lichess", "masters"]);

function snapshotArray<T>(value: readonly T[]): T[] {
  if (!Array.isArray(value)) throw explorerError("invalid_input");
  try {
    return Array.from(value);
  } catch {
    throw explorerError("invalid_input");
  }
}

function requestClock(now: () => number): () => number {
  let previous: number | undefined;
  return () => {
    const current = now();
    if (
      !Number.isFinite(current) ||
      Math.abs(current) > Number.MAX_SAFE_INTEGER ||
      (previous !== undefined && current < previous)
    ) {
      throw explorerError("invalid_input");
    }
    previous = current;
    return current;
  };
}

export function explorerEnabled(): boolean {
  return (process.env.LICHESS_TOKEN || "").length > 0;
}

const processExplorerLimiter = createExplorerLimiter();

interface ExplorerSetup extends ExplorerLimiterOptions {
  db: "lichess" | "masters";
  legalMoves: Map<string, string>;
  limiter: ExplorerLimiter;
  request: ExplorerFetch;
  timeout: (ms: number) => AbortSignal;
  token: string;
  url: string;
  wallNow: () => number;
}

function setupExplorerRequest(
  chess: Chess,
  db: "lichess" | "masters",
  speeds: readonly string[],
  ratings: readonly number[],
  options: ExplorerRequestOptions,
): ExplorerSetup {
  const callerSignal = options.signal;
  throwIfAborted(callerSignal);
  const token = options.token ?? process.env.LICHESS_TOKEN ?? "";
  if (!token) throw explorerError("disabled");
  if (!dbSet.has(db)) throw explorerError("invalid_input");
  const speedValues = snapshotArray(speeds);
  if (
    !speedValues.every((speed) => speedSet.has(speed)) ||
    new Set(speedValues).size !== speedValues.length
  ) {
    throw explorerError("invalid_input");
  }
  const ratingValues = snapshotArray(ratings);
  if (
    !ratingValues.every((rating) => ratingSet.has(rating)) ||
    new Set(ratingValues).size !== ratingValues.length
  ) {
    throw explorerError("invalid_input");
  }
  if (db === "masters" && (speedValues.length > 0 || ratingValues.length > 0)) {
    throw explorerError("invalid_input");
  }

  const params = new URLSearchParams();
  params.set("fen", chess.fen());
  if (speedValues.length) params.set("speeds", speedValues.join(","));
  if (ratingValues.length) params.set("ratings", ratingValues.join(","));

  const now = requestClock(options.now ?? (() => performance.now()));
  const startedAt = now();
  const deadline = startedAt + EXPLORER_TOTAL_TIMEOUT_MS;
  if (
    !Number.isFinite(deadline) ||
    Math.abs(deadline) > Number.MAX_SAFE_INTEGER ||
    deadline <= startedAt
  ) {
    throw explorerError("invalid_input");
  }
  return {
    callerSignal,
    db,
    deadline,
    legalMoves: new Map(
      chess.moves({ verbose: true }).map((move) => [move.lan, move.san]),
    ),
    limiter: options.limiter ?? processExplorerLimiter,
    now,
    request: options.fetch ?? globalThis.fetch,
    sleep:
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    timeout: options.timeout ?? ((ms: number) => AbortSignal.timeout(ms)),
    token,
    url: `${BASE}/${db}?${params}`,
    wallNow: options.wallNow ?? Date.now,
  };
}

function failureFor(
  setup: ExplorerSetup,
  error: ExplorerError,
  retryAfter: string | null = null,
): ExplorerRetryOutcome<ExplorerResult> {
  if (error.kind === "rate_limited") {
    return {
      type: "failure",
      error,
      retry: "limiter",
      delay: rateLimitCooldownMs(retryAfter, setup.wallNow()),
    };
  }
  if (error.kind === "timeout" || error.kind === "network") {
    return {
      type: "failure",
      error,
      retry: "backoff",
      delay: EXPLORER_DEFAULT_RETRY_DELAY_MS,
    };
  }
  if (error.kind === "upstream") {
    return {
      type: "failure",
      error,
      retry: "backoff",
      delay: retryAfterMs(retryAfter, setup.wallNow()),
    };
  }
  return { type: "failure", error, retry: "stop" };
}

async function attemptRequest(
  setup: ExplorerSetup,
): Promise<ExplorerRetryOutcome<ExplorerResult>> {
  try {
    return await setup.limiter.run(setup, async () => {
      const transport = await requestExplorerTransport(setup);
      if (transport.type === "failure") {
        if (transport.error.kind === "rate_limited") {
          setup.limiter.cooldown(
            rateLimitCooldownMs(transport.retryAfter, setup.wallNow()),
            setup.now(),
          );
        }
        return failureFor(setup, transport.error, transport.retryAfter);
      }

      try {
        return {
          type: "success",
          result: await normalizeExplorerResponse(
            transport.response,
            transport.signal,
            { ...setup, cleanupSignal: transport.cleanupSignal },
          ),
        };
      } catch (cause) {
        if (!(cause instanceof ExplorerError)) throw cause;
        return failureFor(setup, cause);
      }
    });
  } catch (cause) {
    if (!(cause instanceof ExplorerError)) throw cause;
    if (cause.kind === "rate_limited") {
      return { type: "failure", error: cause, retry: "stop" };
    }
    return failureFor(setup, cause);
  }
}

export async function openingExplorer(
  chess: Chess,
  db: "lichess" | "masters",
  speeds: readonly string[],
  ratings: readonly number[],
  options: ExplorerRequestOptions = {},
): Promise<ExplorerResult> {
  const setup = setupExplorerRequest(chess, db, speeds, ratings, options);
  return retryExplorer(
    {
      callerSignal: setup.callerSignal,
      deadline: setup.deadline,
      maxAttempts: EXPLORER_MAX_ATTEMPTS,
      now: setup.now,
      sleep: setup.sleep,
    },
    () => attemptRequest(setup),
  );
}
