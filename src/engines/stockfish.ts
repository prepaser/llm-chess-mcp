import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import { dirname, sep } from "node:path";
import type { SfLine } from "../domain.js";
import { ChessError } from "../errors.js";
import { mergeAnalysisInfo, parseAnalysisInfo } from "./stockfish-info.js";

const require = createRequire(import.meta.url);

export const STOCKFISH_FLAVORS = [
  "full",
  "lite",
  "single",
  "lite-single",
  "single-lite",
  "asm",
] as const;

export type StockfishFlavor = (typeof STOCKFISH_FLAVORS)[number];

export type StockfishEngine = {
  listener: ((line: string) => void) | null;
  sendCommand: (cmd: string) => void;
  terminate: () => void;
};

type ProcessListenerCleanup = () => void;

const pendingProcessListenerCleanups = new WeakMap<
  StockfishEngine,
  Set<ProcessListenerCleanup>
>();

function addPendingProcessListenerCleanup(
  engine: StockfishEngine,
  cleanup: ProcessListenerCleanup,
): void {
  const cleanups = pendingProcessListenerCleanups.get(engine);
  if (cleanups) cleanups.add(cleanup);
  else pendingProcessListenerCleanups.set(engine, new Set([cleanup]));
}

function movePendingProcessListenerCleanup(
  from: StockfishEngine,
  to: StockfishEngine,
  cleanup: ProcessListenerCleanup,
): void {
  const cleanups = pendingProcessListenerCleanups.get(from);
  if (!cleanups?.delete(cleanup)) return;
  if (cleanups.size === 0) pendingProcessListenerCleanups.delete(from);
  addPendingProcessListenerCleanup(to, cleanup);
}

function takePendingProcessListenerCleanups(
  engine: StockfishEngine,
): Set<ProcessListenerCleanup> | undefined {
  const cleanups = pendingProcessListenerCleanups.get(engine);
  if (cleanups) pendingProcessListenerCleanups.delete(engine);
  return cleanups;
}

export type StockfishInit = (
  flavor: string,
  cb: (err: Error | null, engine: StockfishEngine) => void,
) => StockfishEngine;

type Timeouts = {
  init: number;
  handshake: number;
  analyze: number;
  stopGrace: number;
};

export type StockfishOptions = {
  init?: StockfishInit;
  flavor?: string;
  maxQueue?: number;
  timeouts?: Partial<Timeouts>;
};

type Session = {
  engine: StockfishEngine | null;
  ready: Promise<void>;
  readySettled: boolean;
  initTimer: NodeJS.Timeout | null;
  resolve: () => void;
  reject: (error: Error) => void;
  invalidators: Set<(error: Error) => void>;
};

type InitAttempt = {
  callbackCalled: boolean;
  callbackEngine: StockfishEngine | null;
  session: Session;
};

type AnalysisRequest = {
  cancelled: boolean;
  cancellation: Error | null;
  started: boolean;
  admissionReleased: boolean;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | null;
  stop: ((error: Error) => void) | null;
  resolve: (lines: SfLine[]) => void;
  reject: (error: Error) => void;
};

type QueuedAnalysis = {
  request: AnalysisRequest;
  run: () => Promise<void>;
};

type EngineTermination = {
  promise: Promise<void>;
  start: () => void;
};

const DEFAULT_FLAVOR: StockfishFlavor = "lite-single";
const FLAVORS = new Set<string>(STOCKFISH_FLAVORS);
const DEFAULT_TIMEOUTS: Timeouts = {
  init: 15000,
  handshake: 15000,
  analyze: 30000,
  stopGrace: 2000,
};
const DEFAULT_MAX_QUEUE = 32;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function resolveStockfishFlavor(value?: string): StockfishFlavor {
  const normalized = (value || DEFAULT_FLAVOR).toLowerCase();
  if (!FLAVORS.has(normalized)) {
    throw new Error(
      `invalid STOCKFISH_FLAVOR: ${JSON.stringify(value)}; expected one of ${STOCKFISH_FLAVORS.join(", ")}`,
    );
  }
  return normalized as StockfishFlavor;
}

function loadStockfish(): StockfishInit {
  const entry = require.resolve("stockfish");
  const packageRoot = dirname(entry) + sep;
  const packageEntry = (id: string) => id === entry || id.startsWith(packageRoot);
  return (flavor, callback) => {
    const cached = new Map(
      Object.entries(require.cache).filter(
        (entry): entry is [string, NodeModule] =>
          packageEntry(entry[0]) && entry[1] !== undefined,
      ),
    );
    for (const id of Object.keys(require.cache)) {
      if (packageEntry(id)) delete require.cache[id];
    }
    try {
      const pendingCallbacks: Array<[
        Error | null,
        StockfishEngine,
      ]> = [];
      let phase: "pending" | "active" | "failed" = "pending";
      let callbackDelivered = false;
      let owner!: StockfishEngine;
      let engine: StockfishEngine;
      const initEngines = new Set<StockfishEngine>();
      const disposedInitEngines = new WeakSet<StockfishEngine>();
      const hooks = captureProcessHooks();
      const disposeInitEngine = (initializedEngine: StockfishEngine) => {
        if (disposedInitEngines.has(initializedEngine)) return;
        disposedInitEngines.add(initializedEngine);
        disposeOrphanEngine(initializedEngine);
      };
      const rollbackInitEngines = () => {
        phase = "failed";
        for (const initializedEngine of initEngines) {
          disposeInitEngine(initializedEngine);
        }
        initEngines.clear();
      };
      const deliver = (
        error: Error | null,
        initializedEngine: StockfishEngine,
      ) => {
        if (!callbackDelivered) {
          callbackDelivered = true;
          if (initializedEngine !== owner) {
            movePendingProcessListenerCleanup(
              owner,
              initializedEngine,
              hooks.cleanup,
            );
            owner = initializedEngine;
          }
        }
        callback(error, initializedEngine);
      };
      try {
        engine = hooks.run(() => {
          const init = require(entry) as StockfishInit;
          return init(flavor, (error, initializedEngine) => {
            hooks.release();
            if (phase === "pending") {
              initEngines.add(initializedEngine);
              pendingCallbacks.push([error, initializedEngine]);
              return;
            }
            if (phase === "failed") {
              disposeInitEngine(initializedEngine);
              return;
            }
            deliver(error, initializedEngine);
          });
        });
        initEngines.add(engine);
      } catch (error) {
        rollbackInitEngines();
        hooks.cleanupSilently();
        throw error;
      }

      addPendingProcessListenerCleanup(engine, hooks.cleanup);
      owner = engine;
      phase = "active";
      for (const [error, initializedEngine] of pendingCallbacks) {
        deliver(error, initializedEngine);
      }
      initEngines.clear();
      return engine;
    } finally {
      for (const id of Object.keys(require.cache)) {
        if (packageEntry(id)) delete require.cache[id];
      }
      for (const [id, module] of cached) require.cache[id] = module;
    }
  };
}

function disposeOrphanEngine(engine: StockfishEngine): void {
  try {
    engine.listener = () => {};
  } catch {}
  try {
    if (typeof engine.sendCommand === "function") engine.sendCommand("quit");
  } catch {}
  try {
    engine.terminate();
  } catch {}
}

type HookEvent = "uncaughtException" | "unhandledRejection";
type HookListener = (...args: unknown[]) => void;
type HookMethod = (
  event: string | symbol,
  listener: HookListener,
) => NodeJS.Process;
type HookMethodName =
  | "on"
  | "addListener"
  | "prependListener"
  | "once"
  | "prependOnceListener";

type HookCapture = {
  active: boolean;
  pending: Record<HookEvent, Set<HookListener>>;
  registering: boolean;
  remove: typeof process.removeListener;
  resources: Set<number>;
  terminal: boolean;
};

const hookMethodNames: HookMethodName[] = [
  "on",
  "addListener",
  "prependListener",
  "once",
  "prependOnceListener",
];
const hookStorage = new AsyncLocalStorage<HookCapture>();
const activeHookCaptures = new Set<HookCapture>();
const hookResources = new Map<number, HookCapture>();
let hookMethods:
  | {
      descriptors: Record<HookMethodName, PropertyDescriptor | undefined>;
      original: Record<HookMethodName, HookMethod>;
    }
  | undefined;

function releaseHookResource(asyncId: number): void {
  const capture = hookResources.get(asyncId);
  if (!capture) return;
  hookResources.delete(asyncId);
  capture.resources.delete(asyncId);
  if (!capture.terminal || capture.resources.size !== 0) return;
  capture.terminal = false;
  activeHookCaptures.delete(capture);
  try {
    restoreHookMethods();
  } catch {}
}

const hookTracker = createHook({
  init(asyncId) {
    const capture = hookStorage.getStore();
    if (!capture || (!capture.active && !capture.terminal)) return;
    capture.resources.add(asyncId);
    hookResources.set(asyncId, capture);
  },
  destroy: releaseHookResource,
  promiseResolve: releaseHookResource,
});

function hookRaw(event: HookEvent): HookListener[] {
  return process.rawListeners(event) as HookListener[];
}

function restoreHookMethods(): void {
  if (!hookMethods || activeHookCaptures.size !== 0) return;
  const mutable = process as unknown as Record<HookMethodName, HookMethod>;
  const { descriptors } = hookMethods;
  let failure: unknown;
  for (const name of hookMethodNames) {
    try {
      const descriptor = descriptors[name];
      if (descriptor) Object.defineProperty(process, name, descriptor);
      else delete mutable[name];
    } catch (error) {
      failure ??= error;
    }
  }
  hookMethods = undefined;
  hookTracker.disable();
  hookResources.clear();
  if (failure) throw failure;
}

function installHookMethods(): void {
  if (hookMethods) return;
  const mutable = process as unknown as Record<HookMethodName, HookMethod>;
  const original = Object.fromEntries(
    hookMethodNames.map((name) => [name, mutable[name]]),
  ) as Record<HookMethodName, HookMethod>;
  const descriptors = Object.fromEntries(
    hookMethodNames.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(process, name),
    ]),
  ) as Record<HookMethodName, PropertyDescriptor | undefined>;
  hookMethods = { descriptors, original };
  hookTracker.enable();

  const isHookEvent = (event: string | symbol): event is HookEvent =>
    event === "uncaughtException" || event === "unhandledRejection";
  const intercept = (name: HookMethodName, once: boolean): HookMethod =>
    function interceptedProcessHook(
      this: NodeJS.Process,
      event,
      listener,
    ) {
      const capture = hookStorage.getStore();
      if (
        this === process &&
        capture?.terminal &&
        isHookEvent(event) &&
        typeof listener === "function"
      ) {
        return this;
      }
      if (
        this !== process ||
        !capture?.active ||
        !isHookEvent(event) ||
        typeof listener !== "function" ||
        capture.registering
      ) {
        return Reflect.apply(original[name], this, [event, listener]);
      }
      const registration = function registeredProcessHook(
        this: NodeJS.Process,
        ...args: unknown[]
      ) {
        if (once) Reflect.apply(capture.remove, this, [event, registration]);
        Reflect.apply(listener, this, args);
      };
      Object.defineProperty(registration, "listener", { value: listener });
      const method = once
        ? name === "prependOnceListener"
          ? original.prependListener
          : original.on
        : original[name];
      capture.registering = true;
      try {
        return Reflect.apply(method, this, [event, registration]);
      } finally {
        capture.registering = false;
        if (hookRaw(event).includes(registration)) {
          capture.pending[event].add(registration);
        }
      }
    };
  const setMethod = (name: HookMethodName, method: HookMethod) => {
    const descriptor = descriptors[name];
    if (descriptor && Object.hasOwn(descriptor, "value")) {
      Object.defineProperty(process, name, { ...descriptor, value: method });
    } else {
      mutable[name] = method;
    }
  };

  try {
    const on = intercept("on", false);
    setMethod("on", on);
    setMethod("addListener", original.on === original.addListener ? on : intercept("addListener", false));
    setMethod("prependListener", intercept("prependListener", false));
    setMethod("once", intercept("once", true));
    setMethod("prependOnceListener", intercept("prependOnceListener", true));
  } catch (error) {
    activeHookCaptures.clear();
    try {
      restoreHookMethods();
    } catch {}
    throw error;
  }
}

function captureProcessHooks(): {
  cleanup: () => void;
  cleanupSilently: () => void;
  release: () => void;
  run: <T>(fn: () => T) => T;
} {
  const capture: HookCapture = {
    active: false,
    pending: {
      uncaughtException: new Set(),
      unhandledRejection: new Set(),
    },
    registering: false,
    remove: process.removeListener,
    resources: new Set(),
    terminal: false,
  };
  const release = () => {
    if (!capture.active) return;
    capture.active = false;
    activeHookCaptures.delete(capture);
    restoreHookMethods();
  };
  const retire = () => {
    if (!capture.active) return;
    capture.active = false;
    capture.terminal = true;
    if (capture.resources.size !== 0) return;
    capture.terminal = false;
    activeHookCaptures.delete(capture);
    restoreHookMethods();
  };
  const cleanupEvent = (event: HookEvent) => {
    let failure: unknown;
    for (let attempt = 0; attempt < 2 && capture.pending[event].size !== 0; attempt++) {
      failure = undefined;
      for (const registration of capture.pending[event]) {
        try {
          Reflect.apply(capture.remove, process, [event, registration]);
        } catch (error) {
          failure ??= error;
        } finally {
          if (!hookRaw(event).includes(registration)) {
            capture.pending[event].delete(registration);
          }
        }
      }
    }
    if (capture.pending[event].size !== 0) {
      throw failure ?? new Error("stockfish process listener cleanup failed");
    }
  };
  const cleanup = () => {
    let failure: unknown;
    try {
      retire();
    } catch (error) {
      failure = error;
    }
    for (const event of ["uncaughtException", "unhandledRejection"] as const) {
      try {
        cleanupEvent(event);
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure) throw failure;
  };

  return {
    cleanup,
    cleanupSilently: () => {
      try {
        cleanup();
      } catch {}
    },
    release,
    run: <T>(fn: () => T) => {
      if (!capture.active) {
        installHookMethods();
        capture.active = true;
        activeHookCaptures.add(capture);
        capture.remove = process.removeListener;
      }
      return hookStorage.run(capture, fn);
    },
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal): Error {
  return asError(signal.reason ?? "stockfish request cancelled");
}

function ownOption<K extends keyof StockfishOptions>(
  options: StockfishOptions,
  name: K,
): StockfishOptions[K] | undefined {
  return Object.hasOwn(options, name) ? options[name] : undefined;
}

function mergeTimeouts(value: Partial<Timeouts> | undefined): Timeouts {
  if (value === undefined) return { ...DEFAULT_TIMEOUTS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("stockfish timeouts must be an object");
  }

  const timeouts = { ...DEFAULT_TIMEOUTS };
  for (const name of Object.keys(DEFAULT_TIMEOUTS) as (keyof Timeouts)[]) {
    if (Object.hasOwn(value, name)) timeouts[name] = value[name]!;
  }
  return timeouts;
}

export class Stockfish {
  private session: Session | null = null;
  private queue: QueuedAnalysis[] = [];
  private runInProgress = false;
  private queueScheduled = false;
  private admitted = 0;
  private quitGeneration = 0;
  private activeRequest: AnalysisRequest | null = null;
  private quitting: Promise<void> | null = null;
  private teardownBarrier: Promise<void> = Promise.resolve();
  private teardownPending = 0;
  private readonly drainWaiters = new Set<() => void>();
  private readonly terminations = new WeakMap<StockfishEngine, EngineTermination>();
  private readonly processListenerCleanups = new WeakMap<
    StockfishEngine,
    Set<ProcessListenerCleanup>
  >();
  private readonly initEngine: StockfishInit | undefined;
  private readonly configuredFlavor: string | undefined;
  private readonly maxQueue: number;
  private readonly timeouts: Timeouts;

  constructor(options: StockfishOptions = {}) {
    this.initEngine = ownOption(options, "init");
    this.configuredFlavor = ownOption(options, "flavor");
    this.maxQueue = ownOption(options, "maxQueue") ?? DEFAULT_MAX_QUEUE;
    this.timeouts = mergeTimeouts(ownOption(options, "timeouts"));

    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1) {
      throw new Error("stockfish maxQueue must be a positive integer");
    }
    for (const [name, timeout] of Object.entries(this.timeouts)) {
      if (
        !Number.isSafeInteger(timeout) ||
        timeout < 1 ||
        timeout > MAX_TIMER_DELAY_MS
      ) {
        throw new Error(
          `stockfish ${name} timeout must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`,
        );
      }
    }
  }

  private disposeInitEngine(engine: StockfishEngine): void {
    this.claimProcessListenerCleanups(engine);
    if (engine !== this.session?.engine) this.terminate(engine);
  }

  private claimProcessListenerCleanups(engine: StockfishEngine): void {
    const pending = takePendingProcessListenerCleanups(engine);
    if (!pending) return;
    const owned = this.processListenerCleanups.get(engine);
    if (owned) {
      for (const cleanup of pending) owned.add(cleanup);
    } else {
      this.processListenerCleanups.set(engine, pending);
    }
  }

  private moveProcessListenerCleanups(
    from: StockfishEngine,
    to: StockfishEngine,
  ): void {
    const cleanups = this.processListenerCleanups.get(from);
    if (!cleanups) return;
    this.processListenerCleanups.delete(from);
    const target = this.processListenerCleanups.get(to);
    if (target) {
      for (const cleanup of cleanups) target.add(cleanup);
    } else {
      this.processListenerCleanups.set(to, cleanups);
    }
  }

  private adoptInitEngine(attempt: InitAttempt, engine: StockfishEngine): boolean {
    this.claimProcessListenerCleanups(engine);
    const { session } = attempt;
    if (this.session !== session || session.readySettled) {
      this.disposeInitEngine(engine);
      return false;
    }
    if (this.terminations.has(engine)) {
      this.failSession(
        session,
        new Error("stockfish initializer reused a terminated engine"),
      );
      return false;
    }

    const replacedEngine = session.engine;
    if (replacedEngine && replacedEngine !== engine) {
      this.moveProcessListenerCleanups(replacedEngine, engine);
      this.terminate(replacedEngine);
      if (
        this.session !== session ||
        session.readySettled ||
        session.engine !== replacedEngine
      ) {
        this.disposeInitEngine(engine);
        return false;
      }
    }
    session.engine = engine;
    engine.listener = () => {};
    return true;
  }

  private completeInit(
    attempt: InitAttempt,
    error: Error | null,
    engine: StockfishEngine,
  ): void {
    if (attempt.callbackCalled) {
      if (engine !== attempt.callbackEngine) this.disposeInitEngine(engine);
      return;
    }
    attempt.callbackCalled = true;
    attempt.callbackEngine = engine;
    const { session } = attempt;
    if (!this.adoptInitEngine(attempt, engine)) return;
    if (error) {
      this.failSession(session, asError(error));
      return;
    }
    if (session.initTimer) clearTimeout(session.initTimer);
    session.initTimer = null;
    this.handshake(session).then(
      () => {
        if (this.session !== session || session.readySettled) return;
        session.readySettled = true;
        session.resolve();
      },
      (handshakeError: unknown) =>
        this.failSession(session, asError(handshakeError)),
    );
  }

  private init(): Promise<void> {
    if (this.session) return this.session.ready;

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const session: Session = {
      engine: null,
      ready,
      readySettled: false,
      initTimer: null,
      resolve,
      reject,
      invalidators: new Set(),
    };
    this.session = session;
    const attempt: InitAttempt = {
      callbackCalled: false,
      callbackEngine: null,
      session,
    };
    session.initTimer = setTimeout(
      () => this.failSession(session, new Error("stockfish init timeout")),
      this.timeouts.init,
    );

    try {
      const selectedFlavor = resolveStockfishFlavor(
        this.configuredFlavor ?? process.env.STOCKFISH_FLAVOR,
      );
      const engine = (this.initEngine ?? loadStockfish())(
        selectedFlavor,
        (error, initializedEngine) =>
          this.completeInit(attempt, error, initializedEngine),
      );

      if (attempt.callbackCalled) this.disposeInitEngine(engine);
      else this.adoptInitEngine(attempt, engine);
    } catch (error) {
      this.failSession(session, asError(error));
    }

    return ready;
  }

  private handshake(session: Session): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const engine = session.engine;
      if (!engine) {
        reject(new Error("stockfish initialized without an engine"));
        return;
      }

      let stage = 0;
      let settled = false;
      let unregisterInvalidator: (() => void) | null = null;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unregisterInvalidator?.();
        unregisterInvalidator = null;
        if (engine.listener === listener) engine.listener = null;
        if (error) reject(error);
        else resolve();
      };
      const abort = (error: Error) => finish(error);
      const listener = (line: string) => {
        if (stage === 0 && line === "uciok") {
          stage = 1;
          try {
            engine.sendCommand("isready");
          } catch (error) {
            finish(asError(error));
          }
        } else if (stage === 1 && line === "readyok") {
          finish();
        }
      };
      const timer = setTimeout(
        () => finish(new Error("stockfish handshake timeout")),
        this.timeouts.handshake,
      );

      unregisterInvalidator = this.registerInvalidator(session, abort);
      engine.listener = listener;
      try {
        engine.sendCommand("uci");
      } catch (error) {
        finish(asError(error));
      }
    });
  }

  private registerInvalidator(
    session: Session,
    invalidator: (error: Error) => void,
  ): () => void {
    session.invalidators.add(invalidator);
    return () => session.invalidators.delete(invalidator);
  }

  private releaseAdmission(request: AnalysisRequest): void {
    if (request.admissionReleased) return;
    request.admissionReleased = true;
    this.admitted--;
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
    request.abortListener = null;
    this.notifyDrained();
  }

  private notifyDrained(): void {
    if (this.admitted !== 0 || this.runInProgress || this.queue.length !== 0) return;
    const waiters = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForDrain(): Promise<void> {
    if (this.admitted === 0 && !this.runInProgress && this.queue.length === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private scheduleQueue(): void {
    if (this.runInProgress || this.queueScheduled) return;
    if (this.teardownPending !== 0) {
      this.queueScheduled = true;
      void this.teardownBarrier.finally(() => {
        this.queueScheduled = false;
        this.scheduleQueue();
      });
      return;
    }
    this.queueScheduled = true;
    queueMicrotask(() => {
      this.queueScheduled = false;
      if (this.runInProgress) return;
      const next = this.queue.shift();
      if (!next) return;
      if (next.request.cancelled) {
        this.releaseAdmission(next.request);
        this.scheduleQueue();
        return;
      }

      this.runInProgress = true;
      this.activeRequest = next.request;
      void next.run().finally(() => {
        this.releaseAdmission(next.request);
        if (this.activeRequest === next.request) this.activeRequest = null;
        this.runInProgress = false;
        this.notifyDrained();
        this.scheduleQueue();
      });
    });
  }

  private removeQueued(request: AnalysisRequest): void {
    const index = this.queue.findIndex((item) => item.request === request);
    if (index < 0) return;
    this.queue.splice(index, 1);
  }

  private enqueue(request: AnalysisRequest, fn: () => Promise<void>): void {
    this.admitted++;
    this.queue.push({ request, run: fn });
    this.scheduleQueue();
  }

  analyze(
    fen: string,
    depth: number,
    multipv: number,
    signal?: AbortSignal,
  ): Promise<SfLine[]> {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (this.quitting) {
      return Promise.reject(new Error("stockfish shutting down"));
    }
    if (this.admitted >= this.maxQueue) {
      return Promise.reject(
        new ChessError("SERVER_BUSY", "stockfish queue full"),
      );
    }

    const quitGeneration = this.quitGeneration;
    let request!: AnalysisRequest;
    const result = new Promise<SfLine[]>((resolve, reject) => {
      request = {
        cancelled: false,
        cancellation: null,
        started: false,
        admissionReleased: false,
        signal,
        abortListener: null,
        stop: null,
        resolve,
        reject,
      };
    });
    const cancel = () => {
      if (request.cancelled) return;
      const error = request.signal
        ? abortError(request.signal)
        : new Error("stockfish request cancelled");
      request.cancelled = true;
      request.cancellation = error;
      if (request.started) {
        if (request.stop) request.stop(error);
        else {
          request.reject(error);
          this.releaseAdmission(request);
        }
      } else {
        this.removeQueued(request);
        request.reject(error);
        this.releaseAdmission(request);
        this.scheduleQueue();
      }
    };
    request.abortListener = cancel;

    this.enqueue(request, async () => {
      if (request.cancelled) return;
      request.started = true;
      try {
        if (quitGeneration !== this.quitGeneration) {
          throw new Error("stockfish request cancelled");
        }
        await this.init();
        if (request.cancelled || quitGeneration !== this.quitGeneration) {
          if (!request.cancelled) {
            throw new Error("stockfish request cancelled");
          }
          return;
        }
        const session = this.session;
        if (!session) throw new Error("stockfish unavailable after initialization");
        const lines = await this.doAnalyze(
          session,
          fen,
          depth,
          multipv,
          (stop) => {
            request.stop = stop;
          },
        );
        if (!request.cancelled) request.resolve(lines);
      } catch (error) {
        if (!request.cancelled) request.reject(asError(error));
      } finally {
        request.stop = null;
        if (request.cancellation) request.reject(request.cancellation);
      }
    });
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    return result;
  }

  private doAnalyze(
    session: Session,
    fen: string,
    depth: number,
    multipv: number,
    setStop: (stop: ((error: Error) => void) | null) => void,
  ): Promise<SfLine[]> {
    return new Promise<SfLine[]>((resolve, reject) => {
      const engine = session.engine;
      if (!engine) {
        reject(new Error("stockfish engine unavailable"));
        return;
      }

      const byPv = new Map<number, SfLine>();
      let settled = false;
      let cancellation: Error | null = null;
      let timeout: Error | null = null;
      let stopSent = false;
      let stopTimer: NodeJS.Timeout | null = null;
      let failTimer: NodeJS.Timeout | null = null;
      let unregisterInvalidator: (() => void) | null = null;

      const cleanup = () => {
        if (stopTimer) clearTimeout(stopTimer);
        if (failTimer) clearTimeout(failTimer);
        stopTimer = null;
        failTimer = null;
        setStop(null);
        unregisterInvalidator?.();
        unregisterInvalidator = null;
        if (engine.listener === listener) engine.listener = null;
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve([...byPv.values()].sort((a, b) => a.multipv - b.multipv));
      };
      const fail = (error: Error, reset: boolean) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (reset) this.invalidateSession(session, error);
        reject(error);
      };
      const abort = (error: Error) => fail(error, false);
      const stop = (error: Error, cancelled: boolean) => {
        if (cancelled) cancellation ??= error;
        else timeout ??= error;
        if (stopSent) return;
        stopSent = true;
        if (stopTimer) clearTimeout(stopTimer);
        stopTimer = null;
        failTimer = setTimeout(
          () => fail(cancellation ?? error, true),
          this.timeouts.stopGrace,
        );
        try {
          engine.sendCommand("stop");
        } catch (sendError) {
          fail(asError(sendError), true);
        }
      };
      const listener = (line: string) => {
        const info = parseAnalysisInfo(line);
        if (info) {
          byPv.set(
            info.multipv,
            mergeAnalysisInfo(byPv.get(info.multipv), info),
          );
        } else if (line.startsWith("bestmove")) {
          if (cancellation) fail(cancellation, false);
          else if (timeout) fail(timeout, false);
          else succeed();
        }
      };

      unregisterInvalidator = this.registerInvalidator(session, abort);
      engine.listener = listener;
      setStop((error) => stop(error, true));
      stopTimer = setTimeout(() => {
        stop(new Error("stockfish analyze timeout"), false);
      }, this.timeouts.analyze);
      try {
        engine.sendCommand("position fen " + fen);
        engine.sendCommand(`setoption name MultiPV value ${multipv}`);
        engine.sendCommand("setoption name UCI_ShowWDL value true");
        engine.sendCommand(`go depth ${depth}`);
      } catch (error) {
        fail(asError(error), true);
        return;
      }
    });
  }

  private failSession(session: Session, error: Error): void {
    if (session.readySettled) return;
    session.readySettled = true;
    if (session.initTimer) clearTimeout(session.initTimer);
    session.initTimer = null;
    this.invalidateSession(session, error);
    session.reject(error);
  }

  private invalidateSession(session: Session, error: Error): void {
    if (this.session !== session) return;
    this.session = null;
    if (session.initTimer) clearTimeout(session.initTimer);
    session.initTimer = null;
    if (!session.readySettled) {
      session.readySettled = true;
      session.reject(error);
    }
    const invalidators = [...session.invalidators];
    session.invalidators.clear();
    if (session.engine) {
      this.terminate(session.engine);
    }
    for (const invalidate of invalidators) invalidate(error);
  }

  private terminate(engine: StockfishEngine): Promise<void> {
    engine.listener = () => {};
    const existing = this.terminations.get(engine);
    if (existing) {
      existing.start();
      return existing.promise;
    }

    this.teardownPending++;
    let resolve!: () => void;
    const completion = new Promise<void>((res) => {
      resolve = res;
    });
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      resolve();
    };
    const promise = completion.finally(() => {
      this.teardownPending--;
    });
    let quitSent = false;
    let terminateScheduled = false;
    let fallback: NodeJS.Timeout | null = null;
    const stopEngine = () => {
      if (terminateScheduled) return;
      terminateScheduled = true;
      setImmediate(() => {
        try {
          try {
            engine.listener = () => {};
            engine.terminate();
          } catch {}
          const cleanups = this.processListenerCleanups.get(engine);
          if (cleanups) {
            this.processListenerCleanups.delete(engine);
            for (const cleanup of cleanups) {
              try {
                cleanup();
              } catch {}
            }
          }
        } finally {
          finish();
        }
      });
    };
    const termination: EngineTermination = {
      promise,
      start: () => {
        if (quitSent || typeof engine.sendCommand !== "function") return;
        quitSent = true;
        if (fallback) clearTimeout(fallback);
        fallback = null;
        engine.listener = () => {};
        try {
          engine.sendCommand("quit");
        } catch {}
        stopEngine();
      },
    };
    fallback = setTimeout(() => {
      fallback = null;
      stopEngine();
    }, this.timeouts.stopGrace);
    this.terminations.set(engine, termination);
    this.teardownBarrier = Promise.all([
      this.teardownBarrier,
      promise,
    ]).then(() => undefined);
    termination.start();
    return promise;
  }

  private cancelQueued(error: Error): void {
    const queued = this.queue.splice(0);
    for (const { request } of queued) {
      if (request.cancelled) continue;
      request.cancelled = true;
      request.cancellation = error;
      request.reject(error);
      this.releaseAdmission(request);
    }
    this.notifyDrained();
  }

  private async performQuit(): Promise<void> {
    this.quitGeneration++;
    const quitError = new Error("stockfish quit");
    this.cancelQueued(new Error("stockfish request cancelled"));

    const session = this.session;
    const active = this.activeRequest;
    if (active) {
      active.cancelled = true;
      active.cancellation ??= quitError;
      if (active.stop) active.stop(active.cancellation);
      else {
        active.reject(active.cancellation);
        if (session) this.invalidateSession(session, quitError);
      }
    }

    await this.waitForDrain();
    if (this.session) this.invalidateSession(this.session, quitError);
    await this.teardownBarrier;
  }

  quit(): Promise<void> {
    if (this.quitting) return this.quitting;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    let operation!: Promise<void>;
    operation = pending.finally(() => {
      if (this.quitting === operation) this.quitting = null;
    });
    this.quitting = operation;
    void this.performQuit().then(resolve, reject);
    return operation;
  }
}

export const stockfish = new Stockfish();
