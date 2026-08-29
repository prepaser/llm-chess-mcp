import { Chess } from "chess.js";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { Maia3Move } from "../domain.js";
import { ChessError } from "../errors.js";
import { mirrorMove } from "./mirror.js";
import {
  assertSessionContract,
  createCheckedSession,
  extractMoveLogits,
} from "./session.js";
import { buildInput } from "./tokenize.js";
import { vocabIndex } from "./vocab.js";
import type {
  MaiaWorkerRequest,
  MaiaWorkerResponse,
} from "./inference-worker.js";

const MODEL_KEYS = new Set(["3m", "5m", "23m", "79m"]);
const DEFAULT_MAX_CONCURRENCY = 2;
const DEFAULT_MAX_QUEUE = 32;
const DEFAULT_TIMEOUT_MS = 30_000;

type AdmissionWaiter = {
  onAbort: () => void;
  signal: AbortSignal | undefined;
  start: () => void;
  reject: (error: unknown) => void;
};

export class MaiaAdmission {
  readonly maxConcurrency: number;
  readonly maxQueue: number;
  #active = 0;
  #queue: AdmissionWaiter[] = [];

  constructor(maxConcurrency = DEFAULT_MAX_CONCURRENCY, maxQueue = DEFAULT_MAX_QUEUE) {
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("Maia3 maxConcurrency must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
      throw new Error("Maia3 maxQueue must be a non-negative safe integer");
    }
    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
  }

  get active(): number {
    return this.#active;
  }

  get pending(): number {
    return this.#queue.length;
  }

  run<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
    if (signal?.aborted) signal.throwIfAborted();
    if (this.#active < this.maxConcurrency) return this.#start(work);
    if (this.#queue.length >= this.maxQueue) {
      return Promise.reject(
        new ChessError("SERVER_BUSY", "Maia3 inference queue full"),
      );
    }

    return new Promise<T>((resolve, reject) => {
      let waiter!: AdmissionWaiter;
      const remove = () => {
        const index = this.#queue.indexOf(waiter);
        if (index < 0) return;
        this.#queue.splice(index, 1);
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
        reject(waiter.signal?.reason);
      };
      waiter = {
        onAbort: remove,
        signal,
        reject,
        start: () => {
          void this.#start(work).then(resolve, reject);
        },
      };
      this.#queue.push(waiter);
      signal?.addEventListener("abort", remove, { once: true });
      if (signal?.aborted) remove();
    });
  }

  cancelQueued(error: Error): void {
    const queue = this.#queue.splice(0);
    for (const waiter of queue) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  #start<T>(work: () => Promise<T>): Promise<T> {
    this.#active += 1;
    return Promise.resolve()
      .then(work)
      .finally(() => {
        this.#active -= 1;
        const next = this.#queue.shift();
        if (!next) return;
        next.signal?.removeEventListener("abort", next.onAbort);
        next.start();
      });
  }
}

type PendingWorkerRequest = {
  id: number;
  failed: boolean;
  failure: unknown | null;
  signal: AbortSignal | undefined;
  onAbort: () => void;
  timer: NodeJS.Timeout;
  resolve: (logits: Float32Array) => void;
  reject: (error: unknown) => void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function responseError(response: Extract<MaiaWorkerResponse, { ok: false }>): Error {
  const error = new Error(response.error.message);
  error.name = response.error.name;
  if (response.error.stack !== undefined) error.stack = response.error.stack;
  return error;
}

function workerExecArgv(url: URL): string[] {
  if (!url.pathname.endsWith(".ts")) return [];
  const valueOptions = new Set([
    "--require",
    "-r",
    "--import",
    "--loader",
    "--experimental-loader",
  ]);
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index];
    if (arg !== undefined && valueOptions.has(arg)) {
      const value = process.execArgv[index + 1];
      if (value !== undefined) args.push(arg, value);
      index += 1;
      continue;
    }
    if (
      arg !== undefined &&
      [...valueOptions].some((option) => arg.startsWith(`${option}=`))
    ) {
      args.push(arg);
    }
  }
  return args;
}

class MaiaWorkerSlot {
  #worker: Worker | null = null;
  #pending: PendingWorkerRequest | null = null;
  #retiring: Promise<void> | null = null;
  #retireWhenIdle = false;
  #closeCompletion: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  #nextId = 1;

  constructor(
    private readonly workerUrl: URL,
    private readonly timeoutMs: number,
  ) {}

  get busy(): boolean {
    return this.#pending !== null || this.#retiring !== null;
  }

  run(
    request: Omit<MaiaWorkerRequest, "type" | "id">,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    signal?.throwIfAborted();
    if (this.busy) throw new Error("Maia3 worker slot is busy");
    const worker = this.#worker ?? this.#spawn();
    worker.ref();
    const id = this.#nextId++;
    return new Promise<Float32Array>((resolve, reject) => {
      const onAbort = () => {
        this.#cancel(signal?.reason ?? new Error("Maia3 inference cancelled"));
      };
      const timer = setTimeout(() => {
        this.#retireWhenIdle = true;
        this.#cancel(new Error("Maia3 inference timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.#pending = {
        id,
        failed: false,
        failure: null,
        signal,
        onAbort,
        timer,
        resolve,
        reject,
      };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
          void this.#retire(
            signal.reason ?? new Error("Maia3 inference cancelled"),
          );
          return;
        }
        const message: MaiaWorkerRequest = { type: "run", id, ...request };
        worker.postMessage(message, [request.input.buffer as ArrayBuffer]);
      } catch (error) {
        void this.#retire(asError(error));
      }
    });
  }

  close(error: Error): Promise<void> {
    if (this.#retiring) return this.#retiring;
    if (this.#pending) {
      if (this.#closeCompletion) return this.#closeCompletion.promise;
      this.#retireWhenIdle = true;
      this.#cancel(error);
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.#closeCompletion = { promise, resolve, reject };
      return promise;
    }
    const worker = this.#worker;
    if (!worker) return Promise.resolve();
    this.#worker = null;
    const settled = worker
      .terminate()
      .then(() => {})
      .finally(() => {
        if (this.#retiring === settled) this.#retiring = null;
      });
    this.#retiring = settled;
    return settled;
  }

  #spawn(): Worker {
    const worker = new Worker(this.workerUrl, {
      execArgv: workerExecArgv(this.workerUrl),
    });
    this.#worker = worker;
    worker.on("message", (message: unknown) => this.#onMessage(worker, message));
    worker.on("error", (error) => {
      this.#fail(worker, error);
    });
    worker.on("messageerror", (error) => {
      this.#fail(worker, asError(error));
    });
    worker.on("exit", (code) => {
      if (this.#worker !== worker) return;
      if (this.#pending) {
        const pending = this.#takePending();
        this.#worker = null;
        this.#retireWhenIdle = false;
        pending?.reject(
          pending.failed
            ? pending.failure
            : new Error(`Maia3 inference worker exited with code ${code}`),
        );
        this.#finishClose();
      } else {
        this.#worker = null;
      }
    });
    return worker;
  }

  #onMessage(worker: Worker, message: unknown): void {
    if (this.#worker !== worker || !this.#pending) return;
    const response = message as Partial<MaiaWorkerResponse>;
    if (response.id !== this.#pending.id || typeof response.ok !== "boolean") {
      this.#fail(worker, new Error("invalid Maia3 inference worker response"));
      return;
    }
    if (!response.ok) {
      this.#finish(responseError(response as Extract<MaiaWorkerResponse, { ok: false }>));
      return;
    }
    const logits = response.logits;
    if (!(logits instanceof Float32Array)) {
      this.#fail(worker, new Error("invalid Maia3 inference worker logits"));
      return;
    }
    const pending = this.#takePending();
    const retire = this.#retireWhenIdle;
    this.#retireWhenIdle = false;
    const retiring = retire
      ? this.#retire(new Error("Maia3 inference worker retired"))
      : null;
    if (!retiring) worker.unref();
    const finish = () => {
      if (pending?.failed) pending.reject(pending.failure);
      else pending?.resolve(logits);
    };
    if (retiring) void retiring.then(finish);
    else finish();
    this.#settleClose(retiring);
  }

  #fail(worker: Worker, error: Error): void {
    if (this.#worker !== worker) return;
    this.#settleClose(this.#retire(error));
  }

  #finish(error: Error): void {
    const worker = this.#worker;
    const pending = this.#takePending();
    const retire = this.#retireWhenIdle;
    this.#retireWhenIdle = false;
    const retiring = retire ? this.#retire(error) : null;
    if (!retiring) worker?.unref();
    const finish = () =>
      pending?.reject(pending.failed ? pending.failure : error);
    if (retiring) void retiring.then(finish);
    else finish();
    this.#settleClose(retiring);
  }

  #cancel(error: unknown): void {
    const pending = this.#pending;
    if (!pending || pending.failed) return;
    pending.failed = true;
    pending.failure = error;
    this.#retireWhenIdle = true;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
  }

  #settleClose(retiring: Promise<void> | null): void {
    if (!this.#closeCompletion) return;
    if (!retiring) {
      this.#finishClose();
      return;
    }
    void retiring.then(
      () => this.#finishClose(),
      (error: unknown) => {
        const completion = this.#closeCompletion;
        this.#closeCompletion = null;
        completion?.reject(error);
      },
    );
  }

  #finishClose(): void {
    const completion = this.#closeCompletion;
    this.#closeCompletion = null;
    completion?.resolve();
  }

  #takePending(): PendingWorkerRequest | null {
    const pending = this.#pending;
    if (!pending) return null;
    this.#pending = null;
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    return pending;
  }

  #retire(error: unknown): Promise<void> {
    if (this.#retiring) return this.#retiring;
    const pending = this.#takePending();
    this.#retireWhenIdle = false;
    const worker = this.#worker;
    this.#worker = null;
    const retiring = worker
      ? worker.terminate().then(() => {})
      : Promise.resolve();
    const settled = retiring.catch(() => {}).then(() => {
      if (this.#retiring === settled) this.#retiring = null;
      pending?.reject(pending.failed ? pending.failure : error);
    });
    this.#retiring = settled;
    return settled;
  }
}

export class MaiaWorkerPool {
  readonly #slots: MaiaWorkerSlot[];
  #closing: Promise<void> | null = null;

  constructor(size: number, timeoutMs: number, workerUrl: URL) {
    this.#slots = Array.from(
      { length: size },
      () => new MaiaWorkerSlot(workerUrl, timeoutMs),
    );
  }

  run(
    request: Omit<MaiaWorkerRequest, "type" | "id">,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    if (this.#closing) throw new Error("Maia3 inference is shutting down");
    const slot = this.#slots.find((candidate) => !candidate.busy);
    if (!slot) {
      throw new ChessError("SERVER_BUSY", "Maia3 worker pool unavailable");
    }
    return slot.run(request, signal);
  }

  close(error: Error): Promise<void> {
    if (this.#closing) return this.#closing;
    const closing = Promise.all(this.#slots.map((slot) => slot.close(error)))
      .then(() => {})
      .finally(() => {
        if (this.#closing === closing) this.#closing = null;
      });
    this.#closing = closing;
    return closing;
  }
}

const here = dirname(fileURLToPath(import.meta.url));

function modelPath(): string {
  const modelKey = process.env.MAIA3_MODEL || "5m";
  if (!MODEL_KEYS.has(modelKey)) {
    throw new Error(`unsupported Maia3 model: ${modelKey}`);
  }
  const candidates = [
    resolve(here, "../../models", `maia3-${modelKey}.onnx`),
    resolve(process.cwd(), "models", `maia3-${modelKey}.onnx`),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `maia3 model not found (models/maia3-${modelKey}.onnx). Run \`pnpm export:maia3\` first.`,
  );
}

function workerUrl(): URL {
  const js = resolve(here, "inference-worker.js");
  if (existsSync(js)) return pathToFileURL(js);
  const ts = resolve(here, "inference-worker.ts");
  if (existsSync(ts)) return pathToFileURL(ts);
  throw new Error("Maia3 inference worker entry not found");
}

const admission = new MaiaAdmission();
const workers = new MaiaWorkerPool(
  DEFAULT_MAX_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  workerUrl(),
);
let shutdown: Promise<void> | null = null;
let shutdownError: Error | null = null;

export function quitMaia(): Promise<void> {
  if (shutdown) return shutdown;
  const error = new Error("Maia3 inference cancelled by shutdown");
  shutdownError = error;
  admission.cancelQueued(error);
  const closing = workers.close(error).finally(() => {
    if (shutdown === closing) {
      shutdown = null;
      shutdownError = null;
    }
  });
  shutdown = closing;
  return closing;
}

export function softmax(logits: Float32Array): Float32Array {
  if (logits.length === 0) throw new Error("cannot normalize empty logits");
  let max = -Infinity;
  for (const logit of logits) {
    if (Number.isNaN(logit) || logit === Infinity) {
      throw new Error("invalid Maia3 logits");
    }
    if (logit > max) max = logit;
  }
  if (!Number.isFinite(max)) {
    throw new Error("Maia3 logits contain no legal moves");
  }

  let sum = 0;
  const out = new Float32Array(logits.length);
  for (const [i, logit] of logits.entries()) {
    const probability = Math.fround(Math.exp(logit - max));
    out[i] = probability;
    sum += probability;
  }
  out.forEach((value, i) => {
    out[i] = value / sum;
  });
  return out;
}

function valueAt(values: Float32Array, index: number): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(`Maia3 logits index out of range: ${index}`);
  }
  return value;
}

export async function humanMoveDistribution(
  chess: Chess,
  elo: number,
  oppoElo: number,
  topN: number,
  signal?: AbortSignal,
): Promise<Maia3Move[]> {
  signal?.throwIfAborted();
  if (shutdownError) throw shutdownError;
  if (chess.isGameOver()) return [];
  const legal = chess.moves({ verbose: true });
  if (legal.length === 0) return [];
  const input = buildInput(chess);
  const turn = chess.turn();
  const indexedLegal = legal.map((move) => {
    const uci = turn === "w" ? move.lan : mirrorMove(move.lan);
    return { move, index: vocabIndex(uci) };
  });

  return admission.run(signal, async () => {
    signal?.throwIfAborted();
    if (shutdownError) throw shutdownError;
    const logits = await workers.run(
      { modelPath: modelPath(), input, elo, oppoElo },
      signal,
    );
    signal?.throwIfAborted();
    const legalMask = new Float32Array(logits.length).fill(-Infinity);
    for (const { index } of indexedLegal) {
      legalMask[index] = valueAt(logits, index);
    }
    const probs = softmax(legalMask);
    const ranked = indexedLegal
      .map(({ move, index }) => ({
        uci: move.lan,
        san: move.san,
        prob: valueAt(probs, index),
      }))
      .sort((a, b) => b.prob - a.prob);

    signal?.throwIfAborted();
    return ranked.slice(0, topN);
  });
}

export {
  assertSessionContract,
  createCheckedSession,
  extractMoveLogits,
};
