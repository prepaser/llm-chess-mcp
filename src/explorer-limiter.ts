import {
  awaitWithAbort,
  explorerError,
  EXPLORER_MAX_COOLDOWN_MS,
  throwIfAborted,
} from "./explorer-core.js";

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
  #lastNow: number | undefined;
  #queue: QueuedRequest[] = [];

  constructor(private readonly now: () => number) {}

  get pending(): number {
    return this.#queue.length;
  }

  cooldown(ms: number, _now: number): void {
    if (
      !Number.isSafeInteger(ms) ||
      ms < 0 ||
      ms > EXPLORER_MAX_COOLDOWN_MS
    ) {
      throw explorerError("invalid_input");
    }
    const now = this.#readNow();
    const cooldownUntil = now + ms;
    if (!Number.isFinite(cooldownUntil) || (ms > 0 && cooldownUntil <= now)) {
      throw explorerError("invalid_input");
    }
    this.#cooldownUntil = Math.max(this.#cooldownUntil, cooldownUntil);
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
    const delay = Math.ceil(cooldownUntil - this.#readNow());
    if (delay <= 0) return;
    if (delay >= options.deadline - options.now()) {
      throw explorerError("rate_limited");
    }
    return awaitWithAbort(options.callerSignal, () => options.sleep(delay)).then(
      () => {
        const now = this.#readNow();
        if (this.#cooldownUntil > now) throw explorerError("rate_limited");
        this.#cooldownUntil = 0;
      },
    );
  }

  #readNow(): number {
    const now = this.now();
    if (
      !Number.isFinite(now) ||
      Math.abs(now) > Number.MAX_SAFE_INTEGER - EXPLORER_MAX_COOLDOWN_MS ||
      (this.#lastNow !== undefined && now < this.#lastNow)
    ) {
      throw explorerError("invalid_input");
    }
    this.#lastNow = now;
    return now;
  }
}

export function createExplorerLimiter(
  now: () => number = () => performance.now(),
): ExplorerLimiter {
  return new RequestLimiter(now);
}
