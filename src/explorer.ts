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
export const EXPLORER_DEFAULT_RETRY_DELAY_MS = 250;
export const EXPLORER_TOTAL_TIMEOUT_MS = 12_000;
export const EXPLORER_RATE_LIMIT_COOLDOWN_MS = 60_000;

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
  limiter?: ExplorerLimiter;
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
      averageRating: z.number().int().nonnegative().optional(),
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

function rateLimitCooldownMs(value: string | null, now: number): number {
  return value === null || value.trim() === ""
    ? EXPLORER_RATE_LIMIT_COOLDOWN_MS
    : retryAfterMs(value, now);
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

async function awaitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return promise;

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (cause) => {
        cleanup();
        reject(cause);
      },
    );
  });
}

export interface ExplorerLimiterOptions {
  callerSignal: AbortSignal | undefined;
  deadline: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface ExplorerLimiter {
  readonly pending: number;
  run<T>(
    options: ExplorerLimiterOptions,
    request: () => Promise<T>,
  ): Promise<T>;
  cooldown(ms: number, now: number): void;
}

interface QueuedRequest {
  onAbort: () => void;
  signal: AbortSignal | undefined;
  start: () => void;
}

class RequestLimiter implements ExplorerLimiter {
  #active = false;
  #cooldownUntil = 0;
  #queue: QueuedRequest[] = [];

  get pending(): number {
    return this.#queue.length;
  }

  cooldown(ms: number, now: number): void {
    this.#cooldownUntil = Math.max(this.#cooldownUntil, now + ms);
  }

  run<T>(
    options: ExplorerLimiterOptions,
    request: () => Promise<T>,
  ): Promise<T> {
    throwIfAborted(options.callerSignal);
    if (this.#active) return this.#enqueue(options, request);
    this.#active = true;
    return this.#run(options, request);
  }

  #enqueue<T>(
    options: ExplorerLimiterOptions,
    request: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let waiter: QueuedRequest;
      const remove = () => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        reject(waiter.signal?.reason);
      };
      waiter = {
        onAbort: remove,
        signal: options.callerSignal,
        start: () => {
          void this.#run(options, request).then(resolve, reject);
        },
      };
      this.#queue.push(waiter);
      options.callerSignal?.addEventListener("abort", remove, { once: true });
      if (options.callerSignal?.aborted) remove();
    });
  }

  async #run<T>(
    options: ExplorerLimiterOptions,
    request: () => Promise<T>,
  ): Promise<T> {
    try {
      const cooldownWait = this.#waitForCooldown(options);
      if (cooldownWait) await cooldownWait;
      throwIfAborted(options.callerSignal);
      return await request();
    } finally {
      this.#active = false;
      this.#startNext();
    }
  }

  #startNext(): void {
    const waiter = this.#queue.shift();
    if (!waiter) return;
    waiter.signal?.removeEventListener("abort", waiter.onAbort);
    this.#active = true;
    waiter.start();
  }

  #waitForCooldown(options: ExplorerLimiterOptions): Promise<void> | undefined {
    const cooldownUntil = this.#cooldownUntil;
    const delay = cooldownUntil - options.now();
    if (delay <= 0) return;
    if (delay >= options.deadline - options.now()) {
      throw error("rate_limited");
    }
    return sleepWithSignal(options.sleep, delay, options.callerSignal).then(() => {
      if (this.#cooldownUntil === cooldownUntil) this.#cooldownUntil = 0;
    });
  }
}

export function createExplorerLimiter(): ExplorerLimiter {
  return new RequestLimiter();
}

const processExplorerLimiter = createExplorerLimiter();

interface ExplorerSetup {
  callerSignal: AbortSignal | undefined;
  db: "lichess" | "masters";
  deadline: number;
  legalMoves: Map<string, string>;
  limiter: ExplorerLimiter;
  now: () => number;
  request: ExplorerFetch;
  sleep: (ms: number) => Promise<void>;
  timeout: (ms: number) => AbortSignal;
  token: string;
  url: string;
}

interface SuccessfulAttempt {
  result: ExplorerResult;
}

interface SuccessfulResponse {
  response: Response;
  signal: AbortSignal;
}

interface FailedAttempt {
  error: ExplorerError;
  retryAfter?: string | null;
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

  const params = new URLSearchParams();
  params.set("fen", chess.fen());
  if (speeds.length) params.set("speeds", speeds.join(","));
  if (ratings.length) params.set("ratings", ratings.join(","));

  const now = options.now ?? Date.now;
  return {
    callerSignal,
    db,
    deadline: now() + EXPLORER_TOTAL_TIMEOUT_MS,
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
  };
}

async function attemptRequest(
  setup: ExplorerSetup,
): Promise<SuccessfulAttempt | FailedAttempt> {
  return setup.limiter.run(setup, async () => {
    const attempt = await attemptRequestUnlocked(setup);
    if ("error" in attempt) return attempt;
    return {
      result: await normalizeSuccessfulResponse(
        attempt.response,
        attempt.signal,
        setup,
      ),
    };
  });
}

async function discardResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<void> {
  try {
    if (response.body) await awaitWithSignal(response.body.cancel(), signal);
  } catch {
    throwIfAborted(signal);
  }
}

async function attemptRequestUnlocked(
  setup: ExplorerSetup,
): Promise<SuccessfulResponse | FailedAttempt> {
  const { callerSignal, deadline, now, request, timeout, token, url } = setup;
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
    return { error: error(signal.aborted ? "timeout" : "network") };
  }

  throwIfAborted(callerSignal);
  if (response.ok) return { response, signal };

  const kind: ExplorerErrorKind =
    response.status === 401 || response.status === 403
      ? "auth"
      : response.status === 429
      ? "rate_limited"
      : response.status >= 500 && response.status <= 599
        ? "upstream"
        : "http";
  const retryAfter = response.headers.get("retry-after");
  await discardResponse(response, callerSignal);
  if (kind === "rate_limited") {
    const rateLimitedAt = now();
    setup.limiter.cooldown(
      rateLimitCooldownMs(retryAfter, rateLimitedAt),
      rateLimitedAt,
    );
  }
  return {
    error: error(kind, response.status),
    retryAfter,
  };
}

async function normalizeSuccessfulResponse(
  response: Response,
  signal: AbortSignal,
  setup: ExplorerSetup,
): Promise<ExplorerResult> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throwIfAborted(setup.callerSignal);
    if (signal.aborted || cause instanceof TypeError) {
      throw error(signal.aborted ? "timeout" : "network");
    }
    throw error("invalid_response");
  }

  throwIfAborted(setup.callerSignal);
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw error("invalid_response");
  const data = parsed.data;
  const ucis = new Set<string>();
  let white = 0;
  let draws = 0;
  let black = 0;
  for (const move of data.moves) {
    if (ucis.has(move.uci) || setup.legalMoves.get(move.uci) !== move.san) {
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
    db: setup.db,
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

async function retryAfterFailure(
  setup: ExplorerSetup,
  delay: number,
  originalError: ExplorerError,
): Promise<void> {
  if (delay >= setup.deadline - setup.now()) throw originalError;
  await sleepWithSignal(setup.sleep, delay, setup.callerSignal);
  if (setup.deadline - setup.now() <= 0) throw originalError;
}

async function retryAfterNetworkFailure(
  setup: ExplorerSetup,
  originalError: ExplorerError,
): Promise<void> {
  await retryAfterFailure(
    setup,
    EXPLORER_DEFAULT_RETRY_DELAY_MS,
    originalError,
  );
}

export async function openingExplorer(
  chess: Chess,
  db: "lichess" | "masters",
  speeds: readonly string[],
  ratings: readonly number[],
  options: ExplorerRequestOptions = {},
): Promise<ExplorerResult> {
  const setup = setupExplorerRequest(chess, db, speeds, ratings, options);
  let lastError = error("network");
  for (let attempt = 0; attempt < EXPLORER_MAX_ATTEMPTS; attempt += 1) {
    let attemptResult: SuccessfulAttempt | FailedAttempt;
    try {
      attemptResult = await attemptRequest(setup);
    } catch (cause) {
      if (cause instanceof ExplorerError && cause.kind === "rate_limited") {
        throw cause;
      }
      if (!(cause instanceof ExplorerError) || !isRetryable(cause.kind)) {
        throw cause;
      }
      lastError = cause;
      if (attempt + 1 >= EXPLORER_MAX_ATTEMPTS) throw lastError;
      await retryAfterNetworkFailure(setup, lastError);
      continue;
    }
    if ("error" in attemptResult) {
      lastError = attemptResult.error;
      if (!isRetryable(lastError.kind) || attempt + 1 >= EXPLORER_MAX_ATTEMPTS) {
        throw lastError;
      }
      if (attemptResult.retryAfter === undefined) {
        await retryAfterNetworkFailure(setup, lastError);
        continue;
      }
      const delay =
        lastError.kind === "rate_limited"
          ? rateLimitCooldownMs(attemptResult.retryAfter, setup.now())
          : retryAfterMs(attemptResult.retryAfter, setup.now());
      if (lastError.kind === "rate_limited") {
        if (delay >= setup.deadline - setup.now()) throw lastError;
        continue;
      }
      await retryAfterFailure(setup, delay, lastError);
      continue;
    }

    return attemptResult.result;
  }

  throw lastError;
}
