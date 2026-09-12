import type { BearerIdentity } from "./http-auth.js";

export type RateLimit = { ratePerMinute: number; burst: number };

export type SecuritySubject = {
  ip: string;
  bearer?: BearerIdentity | string;
};

export type SecurityRateLimitConfig = {
  global?: RateLimit;
  ip?: RateLimit;
  bearer?: RateLimit;
};

export type HttpRateLimitOptions = HttpSecurityLimits;

export type HttpSecurityLimits = {
  request?: SecurityRateLimitConfig;
  initialize?: SecurityRateLimitConfig;
  work?: SecurityRateLimitConfig;
  authFailure?: SecurityRateLimitConfig;
  control?: SecurityRateLimitConfig;
  maxStateEntries?: number;
  stateTtlMs?: number;
  maxConnectionsPerIp?: number;
  maxSessionsPerIp?: number;
  maxSessionsPerBearer?: number;
  maxWorkPerIp?: number;
  maxWorkPerBearer?: number;
};

const MINUTE = 60_000;

export const DEFAULT_HTTP_SECURITY_LIMITS: Required<
  Omit<HttpSecurityLimits, "request" | "initialize" | "work" | "authFailure" | "control">
> & {
  request: Required<SecurityRateLimitConfig>;
  initialize: Required<SecurityRateLimitConfig>;
  work: Required<SecurityRateLimitConfig>;
  authFailure: Required<SecurityRateLimitConfig>;
  control: Required<SecurityRateLimitConfig>;
} = {
  request: {
    global: { ratePerMinute: 600, burst: 100 },
    ip: { ratePerMinute: 60, burst: 10 },
    bearer: { ratePerMinute: 60, burst: 10 },
  },
  initialize: {
    global: { ratePerMinute: 60, burst: 10 },
    ip: { ratePerMinute: 6, burst: 2 },
    bearer: { ratePerMinute: 6, burst: 2 },
  },
  work: {
    global: { ratePerMinute: 60, burst: 10 },
    ip: { ratePerMinute: 12, burst: 2 },
    bearer: { ratePerMinute: 12, burst: 2 },
  },
  authFailure: {
    global: { ratePerMinute: 120, burst: 20 },
    ip: { ratePerMinute: 10, burst: 5 },
    bearer: { ratePerMinute: 0, burst: 1 },
  },
  control: {
    global: { ratePerMinute: 120, burst: 20 },
    ip: { ratePerMinute: 60, burst: 10 },
    bearer: { ratePerMinute: 60, burst: 10 },
  },
  maxStateEntries: 10_000,
  stateTtlMs: 15 * MINUTE,
  maxConnectionsPerIp: 8,
  maxSessionsPerIp: 4,
  maxSessionsPerBearer: 4,
  maxWorkPerIp: 2,
  maxWorkPerBearer: 2,
};

export type RateLimitKind = "request" | "initialize" | "work" | "authFailure" | "control";
export type RateLimitDimension = "global" | "ip" | "bearer";
export type ConcurrencyKind = "connection" | "session" | "work";

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterMs: number;
};

export type SecurityLease = {
  release(): void;
};

type BucketState = { tokens: number; updatedAt: number; capacity: number; ratePerMinute: number };

function bearerKey(subject: SecuritySubject): string | undefined {
  if (!subject.bearer) return undefined;
  return typeof subject.bearer === "string" ? subject.bearer : subject.bearer.digest;
}

function mergeRateLimit(
  value: SecurityRateLimitConfig | undefined,
  fallback: Required<SecurityRateLimitConfig>,
): Required<SecurityRateLimitConfig> {
  return {
    global: copyRateLimit(value?.global ?? fallback.global),
    ip: copyRateLimit(value?.ip ?? fallback.ip),
    bearer: copyRateLimit(value?.bearer ?? fallback.bearer),
  };
}

function copyRateLimit(value: RateLimit): RateLimit {
  return { ratePerMinute: value.ratePerMinute, burst: value.burst };
}

function validateRateLimit(value: RateLimit, name: string): void {
  if (!Number.isFinite(value.ratePerMinute) || value.ratePerMinute < 0) {
    throw new RangeError(`${name}.ratePerMinute must be non-negative`);
  }
  if (!Number.isInteger(value.burst) || value.burst < 1) {
    throw new RangeError(`${name}.burst must be a positive integer`);
  }
  if (value.ratePerMinute === 0) return;
  if (value.ratePerMinute / MINUTE <= 0) throw new RangeError(`${name} is invalid`);
}

export class HttpSecurity {
  readonly #limits: {
    request: Required<SecurityRateLimitConfig>;
    initialize: Required<SecurityRateLimitConfig>;
    work: Required<SecurityRateLimitConfig>;
    authFailure: Required<SecurityRateLimitConfig>;
    control: Required<SecurityRateLimitConfig>;
    maxStateEntries: number;
    stateTtlMs: number;
    maxConnectionsPerIp: number;
    maxSessionsPerIp: number;
    maxSessionsPerBearer: number;
    maxWorkPerIp: number;
    maxWorkPerBearer: number;
  };
  readonly #clock: () => number;
  readonly #buckets = new Map<string, BucketState>();
  readonly #active = new Map<string, number>();

  constructor(limits: HttpSecurityLimits = {}, clock: () => number = () => performance.now()) {
    this.#limits = {
      request: mergeRateLimit(limits.request, DEFAULT_HTTP_SECURITY_LIMITS.request),
      initialize: mergeRateLimit(limits.initialize, DEFAULT_HTTP_SECURITY_LIMITS.initialize),
      work: mergeRateLimit(limits.work, DEFAULT_HTTP_SECURITY_LIMITS.work),
      authFailure: mergeRateLimit(limits.authFailure, DEFAULT_HTTP_SECURITY_LIMITS.authFailure),
      control: mergeRateLimit(limits.control, DEFAULT_HTTP_SECURITY_LIMITS.control),
      maxStateEntries: limits.maxStateEntries ?? DEFAULT_HTTP_SECURITY_LIMITS.maxStateEntries,
      stateTtlMs: limits.stateTtlMs ?? DEFAULT_HTTP_SECURITY_LIMITS.stateTtlMs,
      maxConnectionsPerIp: limits.maxConnectionsPerIp ?? DEFAULT_HTTP_SECURITY_LIMITS.maxConnectionsPerIp,
      maxSessionsPerIp: limits.maxSessionsPerIp ?? DEFAULT_HTTP_SECURITY_LIMITS.maxSessionsPerIp,
      maxSessionsPerBearer: limits.maxSessionsPerBearer ?? DEFAULT_HTTP_SECURITY_LIMITS.maxSessionsPerBearer,
      maxWorkPerIp: limits.maxWorkPerIp ?? DEFAULT_HTTP_SECURITY_LIMITS.maxWorkPerIp,
      maxWorkPerBearer: limits.maxWorkPerBearer ?? DEFAULT_HTTP_SECURITY_LIMITS.maxWorkPerBearer,
    };
    this.#clock = clock;
    if (!Number.isInteger(this.#limits.maxStateEntries) || this.#limits.maxStateEntries < 1) {
      throw new RangeError("maxStateEntries must be a positive integer");
    }
    if (!Number.isFinite(this.#limits.stateTtlMs) || this.#limits.stateTtlMs < 1) {
      throw new RangeError("stateTtlMs must be positive");
    }
    for (const [name, value] of [
      ["maxStateEntries", this.#limits.maxStateEntries],
      ["maxConnectionsPerIp", this.#limits.maxConnectionsPerIp],
      ["maxSessionsPerIp", this.#limits.maxSessionsPerIp],
      ["maxSessionsPerBearer", this.#limits.maxSessionsPerBearer],
      ["maxWorkPerIp", this.#limits.maxWorkPerIp],
      ["maxWorkPerBearer", this.#limits.maxWorkPerBearer],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    for (const [kind, config] of Object.entries(this.#limits)) {
      if (typeof config !== "object" || config === null || !("global" in config)) continue;
      for (const [dimension, rate] of Object.entries(config)) {
        validateRateLimit(rate as RateLimit, `${kind}.${dimension}`);
      }
    }
  }

  consume(
    kind: RateLimitKind,
    subject: SecuritySubject,
    cost = 1,
    selectedDimensions?: readonly RateLimitDimension[],
  ): RateLimitDecision {
    return this.#rateLimit(kind, subject, cost, selectedDimensions, true);
  }

  check(
    kind: RateLimitKind,
    subject: SecuritySubject,
    cost = 1,
    selectedDimensions?: readonly RateLimitDimension[],
  ): RateLimitDecision {
    return this.#rateLimit(kind, subject, cost, selectedDimensions, false);
  }

  #rateLimit(
    kind: RateLimitKind,
    subject: SecuritySubject,
    cost: number,
    selectedDimensions: readonly RateLimitDimension[] | undefined,
    commit: boolean,
  ): RateLimitDecision {
    if (!Number.isFinite(cost) || cost <= 0) throw new RangeError("cost must be positive");
    const now = this.#clock();
    this.sweep(now);
    const config = this.#limits[kind];
    const requested = new Set(selectedDimensions ?? ["global", "ip", "bearer"]);
    const dimensions: Array<[RateLimitDimension, RateLimit]> = [];
    if (requested.has("global")) dimensions.push(["global", config.global]);
    if (requested.has("ip")) dimensions.push(["ip", config.ip]);
    const bearer = bearerKey(subject);
    if (requested.has("bearer") && bearer) {
      dimensions.push(["bearer", config.bearer]);
    }
    const keys = dimensions.map(([dimension]) => `${kind}:${dimension}:${dimension === "global" ? "*" : dimension === "ip" ? subject.ip : bearer}`);
    const missing = keys.filter((key) => !this.#buckets.has(key)).length;
    if (this.#buckets.size + this.#active.size + missing > this.#limits.maxStateEntries) {
      return { allowed: false, retryAfterMs: MINUTE };
    }
    let retryAfterMs = 0;
    for (let index = 0; index < dimensions.length; index += 1) {
      const [, limit] = dimensions[index]!;
      if (limit.ratePerMinute === 0) {
        retryAfterMs = Math.max(retryAfterMs, MINUTE);
        continue;
      }
      const state = this.#buckets.get(keys[index]!) ?? {
        tokens: limit.burst,
        updatedAt: now,
        capacity: limit.burst,
        ratePerMinute: limit.ratePerMinute,
      };
      const elapsed = Math.max(0, now - state.updatedAt);
      const available = Math.min(limit.burst, state.tokens + elapsed * limit.ratePerMinute / MINUTE);
      if (available < cost) {
        retryAfterMs = Math.max(retryAfterMs, Math.ceil((cost - available) * MINUTE / limit.ratePerMinute));
      }
    }
    if (retryAfterMs > 0) return { allowed: false, retryAfterMs };
    if (!commit) return { allowed: true, retryAfterMs: 0 };
    for (let index = 0; index < dimensions.length; index += 1) {
      const [, limit] = dimensions[index]!;
      const state = this.#buckets.get(keys[index]!) ?? {
        tokens: limit.burst,
        updatedAt: now,
        capacity: limit.burst,
        ratePerMinute: limit.ratePerMinute,
      };
      const elapsed = Math.max(0, now - state.updatedAt);
      state.tokens = Math.min(limit.burst, state.tokens + elapsed * limit.ratePerMinute / MINUTE) - cost;
      state.updatedAt = Math.max(state.updatedAt, now);
      this.#buckets.set(keys[index]!, state);
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  acquire(kind: ConcurrencyKind, subject: SecuritySubject): SecurityLease | RateLimitDecision {
    this.sweep(this.#clock());
    const dimensions: Array<[string, number]> = [];
    if (kind === "connection") dimensions.push([`connection:ip:${subject.ip}`, this.#limits.maxConnectionsPerIp]);
    if (kind === "session") {
      dimensions.push([`session:ip:${subject.ip}`, this.#limits.maxSessionsPerIp]);
      const bearer = bearerKey(subject);
      if (bearer) dimensions.push([`session:bearer:${bearer}`, this.#limits.maxSessionsPerBearer]);
    }
    if (kind === "work") {
      dimensions.push([`work:ip:${subject.ip}`, this.#limits.maxWorkPerIp]);
      const bearer = bearerKey(subject);
      if (bearer) dimensions.push([`work:bearer:${bearer}`, this.#limits.maxWorkPerBearer]);
    }
    const missing = dimensions.filter(([key]) => !this.#active.has(key)).length;
    if (this.#active.size + this.#buckets.size + missing > this.#limits.maxStateEntries) {
      return { allowed: false, retryAfterMs: MINUTE };
    }
    if (dimensions.some(([key, limit]) => (this.#active.get(key) ?? 0) >= limit)) {
      return { allowed: false, retryAfterMs: 1_000 };
    }
    for (const [key] of dimensions) this.#active.set(key, (this.#active.get(key) ?? 0) + 1);
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        for (const [key] of dimensions) {
          const active = (this.#active.get(key) ?? 1) - 1;
          if (active <= 0) this.#active.delete(key);
          else this.#active.set(key, active);
        }
      },
    };
  }

  sweep(now = this.#clock()): void {
    for (const [key, state] of this.#buckets) {
      const available = Math.min(
        state.capacity,
        state.tokens + Math.max(0, now - state.updatedAt) * state.ratePerMinute / MINUTE,
      );
      if (
        !this.#active.has(key) &&
        available >= state.capacity &&
        now - state.updatedAt >= this.#limits.stateTtlMs
      ) {
        this.#buckets.delete(key);
      }
    }
  }

  get stateSize(): number {
    return this.#buckets.size + this.#active.size;
  }
}
