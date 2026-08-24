import { Chess } from "chess.js";
import { z } from "zod/v4";
import type { LichessMove } from "./types.js";

const BASE = "https://explorer.lichess.org";

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

export const EXPLORER_ATTEMPT_TIMEOUT_MS = 5_000;
export const EXPLORER_MAX_ATTEMPTS = 2;
export const EXPLORER_MAX_RETRY_DELAY_MS = 2_000;
export const EXPLORER_DEFAULT_RETRY_DELAY_MS = 250;
export const EXPLORER_TOTAL_TIMEOUT_MS = 12_000;

export const EXPLORER_ERROR_KINDS = [
  "disabled",
  "invalid_input",
  "timeout",
  "network",
  "auth",
  "rate_limited",
  "upstream",
  "http",
  "invalid_response",
] as const;

export type ExplorerErrorKind = (typeof EXPLORER_ERROR_KINDS)[number];

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

export interface ExplorerRequestOptions {
  fetch?: ExplorerFetch;
  sleep?: (ms: number) => Promise<void>;
  timeout?: (ms: number) => AbortSignal;
  signal?: AbortSignal;
  now?: () => number;
  token?: string;
}

const countSchema = z.number().int().nonnegative();
const responseSchema = z.object({
  white: countSchema,
  draws: countSchema,
  black: countSchema,
  moves: z.array(
    z.object({
      uci: z.string().min(1),
      san: z.string().min(1),
      white: countSchema,
      draws: countSchema,
      black: countSchema,
      averageRating: z.number().nonnegative().optional(),
    }),
  ),
  opening: z
    .object({ eco: z.string().min(1), name: z.string().min(1) })
    .nullable()
    .optional(),
});

const speedSet = new Set<string>(LICHESS_SPEEDS);
const ratingSet = new Set<number>(LICHESS_RATINGS);

export function explorerEnabled(): boolean {
  return (process.env.LICHESS_TOKEN || "").length > 0;
}

function error(kind: ExplorerErrorKind, status?: number): ExplorerError {
  const message: Record<ExplorerErrorKind, string> = {
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
  return new ExplorerError(kind, message[kind], status);
}

function retryAfterMs(value: string | null, now: number): number {
  if (!value) return EXPLORER_DEFAULT_RETRY_DELAY_MS;

  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - now;
  if (!Number.isFinite(delay)) return EXPLORER_DEFAULT_RETRY_DELAY_MS;
  return Math.max(0, delay);
}

function isRetryable(kind: ExplorerErrorKind): boolean {
  return (
    kind === "timeout" ||
    kind === "network" ||
    kind === "rate_limited" ||
    kind === "upstream"
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

async function sleepWithSignal(
  sleep: (ms: number) => Promise<void>,
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  if (!signal) return sleep(ms);

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    sleep(ms).then(
      () => {
        cleanup();
        resolve();
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

export async function openingExplorer(
  chess: Chess,
  db: "lichess" | "masters",
  speeds: readonly string[],
  ratings: readonly number[],
  options: ExplorerRequestOptions = {},
): Promise<ExplorerResult> {
  const callerSignal = options.signal;
  throwIfAborted(callerSignal);
  const token = options.token ?? process.env.LICHESS_TOKEN ?? "";
  if (!token) throw error("disabled");
  if (
    !speeds.every((speed) => speedSet.has(speed)) ||
    new Set(speeds).size !== speeds.length
  ) {
    throw error("invalid_input");
  }
  if (
    !ratings.every((rating) => ratingSet.has(rating)) ||
    new Set(ratings).size !== ratings.length
  ) {
    throw error("invalid_input");
  }
  if (db === "masters" && (speeds.length > 0 || ratings.length > 0)) {
    throw error("invalid_input");
  }

  const request = options.fetch ?? globalThis.fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeout = options.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  const now = options.now ?? Date.now;
  const deadline = now() + EXPLORER_TOTAL_TIMEOUT_MS;

  const params = new URLSearchParams();
  params.set("fen", chess.fen());
  if (speeds.length) params.set("speeds", speeds.join(","));
  if (ratings.length) params.set("ratings", ratings.join(","));
  const url = `${BASE}/${db}?${params}`;
  const legalMoves = new Map(
    chess.moves({ verbose: true }).map((move) => [move.lan, move.san]),
  );

  let lastError = error("network");
  for (let attempt = 0; attempt < EXPLORER_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(callerSignal);
    const remaining = deadline - now();
    if (remaining <= 0) throw error("timeout");
    const attemptSignal = timeout(
      Math.max(1, Math.min(EXPLORER_ATTEMPT_TIMEOUT_MS, remaining)),
    );
    const signal = AbortSignal.any(
      callerSignal ? [callerSignal, attemptSignal] : [attemptSignal],
    );

    let response: Response;
    try {
      response = await request(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch {
      throwIfAborted(callerSignal);
      lastError = error(signal.aborted ? "timeout" : "network");
      if (attempt + 1 >= EXPLORER_MAX_ATTEMPTS) throw lastError;
      const delay = Math.min(
        EXPLORER_DEFAULT_RETRY_DELAY_MS,
        Math.max(0, deadline - now()),
      );
      await sleepWithSignal(sleep, delay, callerSignal);
      continue;
    }

    throwIfAborted(callerSignal);

    if (!response.ok) {
      const kind: ExplorerErrorKind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 429
          ? "rate_limited"
          : response.status >= 500 && response.status <= 599
            ? "upstream"
            : "http";
      lastError = error(kind, response.status);
      if (!isRetryable(kind) || attempt + 1 >= EXPLORER_MAX_ATTEMPTS) {
        throw lastError;
      }
      const delay = retryAfterMs(response.headers.get("retry-after"), now());
      const retryBudget = Math.max(0, deadline - now());
      if (delay > EXPLORER_MAX_RETRY_DELAY_MS || delay >= retryBudget) {
        throw lastError;
      }
      await sleepWithSignal(sleep, delay, callerSignal);
      continue;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throwIfAborted(callerSignal);
      if (signal.aborted || cause instanceof TypeError) {
        lastError = error(signal.aborted ? "timeout" : "network");
        if (attempt + 1 < EXPLORER_MAX_ATTEMPTS) {
          const delay = Math.min(
            EXPLORER_DEFAULT_RETRY_DELAY_MS,
            Math.max(0, deadline - now()),
          );
          await sleepWithSignal(sleep, delay, callerSignal);
          continue;
        }
        throw lastError;
      }
      throw error("invalid_response");
    }

    throwIfAborted(callerSignal);
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw error("invalid_response");
    const data = parsed.data;
    const ucis = new Set<string>();
    let white = 0;
    let draws = 0;
    let black = 0;
    for (const move of data.moves) {
      if (
        ucis.has(move.uci) ||
        legalMoves.get(move.uci) !== move.san
      ) {
        throw error("invalid_response");
      }
      ucis.add(move.uci);
      white += move.white;
      draws += move.draws;
      black += move.black;
    }
    if (white > data.white || draws > data.draws || black > data.black) {
      throw error("invalid_response");
    }
    return {
      db,
      white: data.white,
      draws: data.draws,
      black: data.black,
      moves: data.moves.map((move) => ({
        uci: move.uci,
        san: move.san,
        white: move.white,
        draws: move.draws,
        black: move.black,
        count: move.white + move.draws + move.black,
        averageRating: move.averageRating ?? null,
      })),
      opening: data.opening ?? null,
    };
  }

  throw lastError;
}
