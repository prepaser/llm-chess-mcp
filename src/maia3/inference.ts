import { Chess } from "chess.js";
import { fork, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
    if (signal?.aborted) return Promise.reject(signal.reason);
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

function childExecArgv(url: URL): string[] {
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

type NodeOptionToken = {
  value: string;
  start: number;
  end: number;
};

function nodeOptionTokens(value: string): NodeOptionToken[] {
  const tokens: NodeOptionToken[] = [];
  let index = 0;
  while (index < value.length) {
    while (/\s/.test(value[index] ?? "")) index += 1;
    if (index >= value.length) break;
    const start = index;
    let token = "";
    let quote: "'" | '"' | null = null;
    while (index < value.length) {
      const char = value[index];
      if (char === undefined) break;
      if (quote) {
        if (char === quote) {
          quote = null;
          index += 1;
        } else if (char === "\\" && value[index + 1] !== undefined) {
          token += value[index + 1];
          index += 2;
        } else {
          token += char;
          index += 1;
        }
      } else if (/\s/.test(char)) {
        break;
      } else if (char === "'" || char === '"') {
        quote = char;
        index += 1;
      } else if (char === "\\" && value[index + 1] !== undefined) {
        token += value[index + 1];
        index += 2;
      } else {
        token += char;
        index += 1;
      }
    }
    tokens.push({ value: token, start, end: index });
  }
  return tokens;
}

export function withoutNodeInputType(value: string): string {
  const tokens = nodeOptionTokens(value);
  const removed: { start: number; end: number }[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.value === "--input-type") {
      const argument = tokens[index + 1];
      removed.push({
        start: token.start,
        end: argument?.end ?? token.end,
      });
      if (argument) index += 1;
    } else if (token.value.startsWith("--input-type=")) {
      removed.push({ start: token.start, end: token.end });
    }
  }
  let result = "";
  let cursor = 0;
  for (const range of removed) {
    result += value.slice(cursor, range.start);
    cursor = range.end;
  }
  return `${result}${value.slice(cursor)}`.trim();
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "LICHESS_TOKEN") delete env[key];
  }
  if (env.NODE_OPTIONS) {
    env.NODE_OPTIONS = withoutNodeInputType(env.NODE_OPTIONS);
  }
  return env;
}

function setChildReferenced(child: ChildProcess, referenced: boolean): void {
  if (referenced) {
    child.ref();
    child.channel?.ref();
  } else {
    child.unref();
    child.channel?.unref();
  }
}

function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  setChildReferenced(child, true);
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      child.off("exit", finish);
      child.off("error", finish);
      setChildReferenced(child, false);
      resolve();
    };
    child.once("exit", finish);
    child.once("error", finish);
    try {
      if (!child.kill("SIGKILL")) finish();
    } catch {
      finish();
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResponse(
  value: unknown,
  id: number,
): MaiaWorkerResponse | null {
  if (!isRecord(value) || value.id !== id || typeof value.ok !== "boolean") {
    return null;
  }
  if (value.ok) {
    return value.logits instanceof Float32Array
      ? { id, ok: true, logits: value.logits }
      : null;
  }
  if (!isRecord(value.error)) return null;
  const { name, message, stack } = value.error;
  if (
    typeof name !== "string" ||
    typeof message !== "string" ||
    (stack !== undefined && typeof stack !== "string")
  ) {
    return null;
  }
  return {
    id,
    ok: false,
    error: { name, message, ...(stack === undefined ? {} : { stack }) },
  };
}

class MaiaWorkerSlot {
  #child: ChildProcess | null = null;
  #pending: PendingWorkerRequest | null = null;
  #retiring: Promise<void> | null = null;
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
    const child = this.#child ?? this.#spawn();
    setChildReferenced(child, true);
    const id = this.#nextId++;
    return new Promise<Float32Array>((resolve, reject) => {
      const onAbort = () => {
        void this.#retire(signal?.reason);
      };
      const timer = setTimeout(() => {
        void this.#retire(new Error("Maia3 inference timed out"));
      }, this.timeoutMs);
      timer.unref();
      this.#pending = {
        id,
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
          return;
        }
        const message: MaiaWorkerRequest = { type: "run", id, ...request };
        child.send(message, (error) => {
          if (error && this.#pending?.id === id) this.#fail(child, error);
        });
      } catch (error) {
        void this.#retire(asError(error));
      }
    });
  }

  close(error: Error): Promise<void> {
    if (this.#retiring) return this.#retiring;
    if (!this.#child) return Promise.resolve();
    return this.#retire(error);
  }

  #spawn(): ChildProcess {
    const child = fork(fileURLToPath(this.workerUrl), [], {
      env: childEnv(),
      execArgv: childExecArgv(this.workerUrl),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    this.#child = child;
    child.on("message", (message: unknown) => this.#onMessage(child, message));
    child.on("error", (error) => {
      this.#fail(child, error);
    });
    child.on("disconnect", () => {
      if (this.#child === child) {
        this.#fail(child, new Error("Maia3 inference child disconnected"));
      }
    });
    child.on("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      if (this.#pending) {
        const pending = this.#takePending();
        pending?.reject(
          new Error(
            `Maia3 inference child exited (${signal ?? code ?? "unknown"})`,
          ),
        );
      }
    });
    setChildReferenced(child, false);
    return child;
  }

  #onMessage(child: ChildProcess, message: unknown): void {
    if (this.#child !== child || !this.#pending) return;
    const response = parseResponse(message, this.#pending.id);
    if (!response) {
      this.#fail(child, new Error("invalid Maia3 inference child response"));
      return;
    }
    const pending = this.#takePending();
    setChildReferenced(child, false);
    if (response.ok) pending?.resolve(response.logits);
    else pending?.reject(responseError(response));
  }

  #fail(child: ChildProcess, error: Error): void {
    if (this.#child !== child) return;
    void this.#retire(error);
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
    const child = this.#child;
    this.#child = null;
    const settled = (child ? killChild(child) : Promise.resolve()).then(() => {
      if (this.#retiring === settled) this.#retiring = null;
      pending?.reject(error);
    });
    this.#retiring = settled;
    return settled;
  }
}

export class MaiaWorkerPool {
  readonly #slots: MaiaWorkerSlot[];
  #closing: Promise<void> | null = null;

  constructor(size: number, timeoutMs: number, workerUrl: URL) {
    if (!Number.isSafeInteger(size) || size < 1) {
      throw new Error("Maia3 worker pool size must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error(
        `Maia3 worker timeout must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
      );
    }
    this.#slots = Array.from(
      { length: size },
      () => new MaiaWorkerSlot(workerUrl, timeoutMs),
    );
  }

  run(
    request: Omit<MaiaWorkerRequest, "type" | "id">,
    signal?: AbortSignal,
  ): Promise<Float32Array> {
    if (this.#closing) {
      return Promise.reject(new Error("Maia3 inference is shutting down"));
    }
    const slot = this.#slots.find((candidate) => !candidate.busy);
    if (!slot) {
      return Promise.reject(
        new ChessError("SERVER_BUSY", "Maia3 worker pool unavailable"),
      );
    }
    try {
      return slot.run(request, signal);
    } catch (error) {
      return Promise.reject(error);
    }
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
