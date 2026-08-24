import { createRequire } from "node:module";
import type { SfLine } from "../types.js";

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

export type StockfishInit = (
  enginePath: string,
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
  initSettled: boolean;
  initTimer: NodeJS.Timeout | null;
  resolve: () => void;
  reject: (error: Error) => void;
  aborts: Set<(error: Error) => void>;
};

type AnalysisRequest = {
  cancelled: boolean;
  cancellation: Error | null;
  started: boolean;
  released: boolean;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | null;
  stop: ((error: Error) => void) | null;
  resolve: (lines: SfLine[]) => void;
  reject: (error: Error) => void;
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
  return require("stockfish") as StockfishInit;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(signal: AbortSignal): Error {
  return asError(signal.reason ?? "stockfish request cancelled");
}

function parseScore(token: string): { cp: number | null; mate: number | null } {
  if (token.startsWith("cp")) return { cp: Number(token.slice(2)), mate: null };
  if (token.startsWith("mate")) return { cp: null, mate: Number(token.slice(4)) };
  return { cp: null, mate: null };
}

function parseWdl(line: string): [number, number, number] | null {
  const groups = line.match(
    / wdl (?<wins>\d+) (?<draws>\d+) (?<losses>\d+)/,
  )?.groups;
  if (!groups) return null;
  return [Number(groups.wins), Number(groups.draws), Number(groups.losses)];
}

export class Stockfish {
  private session: Session | null = null;
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private quitGeneration = 0;
  private readonly terminated = new WeakSet<StockfishEngine>();
  private readonly initEngine: StockfishInit | undefined;
  private readonly configuredFlavor: string | undefined;
  private readonly maxQueue: number;
  private readonly timeouts: Timeouts;

  constructor(options: StockfishOptions = {}) {
    this.initEngine = options.init;
    this.configuredFlavor = options.flavor;
    this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };

    if (!Number.isInteger(this.maxQueue) || this.maxQueue < 1) {
      throw new Error("stockfish maxQueue must be a positive integer");
    }
    for (const [name, timeout] of Object.entries(this.timeouts)) {
      if (!Number.isFinite(timeout) || timeout < 1) {
        throw new Error(`stockfish ${name} timeout must be positive`);
      }
    }
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
      initSettled: false,
      initTimer: null,
      resolve,
      reject,
      aborts: new Set(),
    };
    this.session = session;
    session.initTimer = setTimeout(
      () => this.failSession(session, new Error("stockfish init timeout")),
      this.timeouts.init,
    );

    let callbackCalled = false;
    try {
      const selectedFlavor = resolveStockfishFlavor(
        this.configuredFlavor ?? process.env.STOCKFISH_FLAVOR,
      );
      const engine = (this.initEngine ?? loadStockfish())(
        selectedFlavor,
        (error, initializedEngine) => {
          callbackCalled = true;
          if (this.session !== session) {
            this.terminate(initializedEngine);
            return;
          }
          if (session.initSettled) {
            if (initializedEngine !== session.engine) this.terminate(initializedEngine);
            return;
          }

          if (session.engine && session.engine !== initializedEngine) {
            this.terminate(session.engine);
          }
          session.engine = initializedEngine;
          if (error) {
            this.failSession(session, asError(error));
            return;
          }
          initializedEngine.listener = () => {};
          if (session.initTimer) clearTimeout(session.initTimer);
          session.initTimer = null;
          this.handshake(session).then(
            () => {
              if (this.session !== session || session.initSettled) return;
              session.initSettled = true;
              session.resolve();
            },
            (handshakeError: unknown) =>
              this.failSession(session, asError(handshakeError)),
          );
        },
      );

      if (!callbackCalled && this.session === session && !session.initSettled) {
        session.engine = engine;
        engine.listener = () => {};
      }
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
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.aborts.delete(abort);
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

      session.aborts.add(abort);
      engine.listener = listener;
      try {
        engine.sendCommand("uci");
      } catch (error) {
        finish(asError(error));
      }
    });
  }

  private release(request: AnalysisRequest): void {
    if (request.released) return;
    request.released = true;
    this.queued--;
    if (request.signal && request.abortListener) {
      request.signal.removeEventListener("abort", request.abortListener);
    }
    request.abortListener = null;
  }

  private enqueue(request: AnalysisRequest, fn: () => Promise<void>): boolean {
    if (this.queued >= this.maxQueue) {
      return false;
    }

    this.queued++;
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => {},
      () => {},
    );
    void run.finally(() => this.release(request));
    return true;
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

    const quitGeneration = this.quitGeneration;
    let request!: AnalysisRequest;
    const result = new Promise<SfLine[]>((resolve, reject) => {
      request = {
        cancelled: false,
        cancellation: null,
        started: false,
        released: false,
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
        request.stop?.(error);
      } else {
        request.reject(error);
        this.release(request);
      }
    };
    request.abortListener = cancel;

    if (!this.enqueue(request, async () => {
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
    })) {
      return Promise.reject(new Error("stockfish queue full"));
    }
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
      let stopSent = false;
      let stopTimer: NodeJS.Timeout | null = null;
      let failTimer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (stopTimer) clearTimeout(stopTimer);
        if (failTimer) clearTimeout(failTimer);
        stopTimer = null;
        failTimer = null;
        setStop(null);
        session.aborts.delete(abort);
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
        if (line.startsWith("info") && line.includes(" multipv ")) {
          const multipv = line.match(/multipv (?<value>\d+)/)?.groups?.value;
          if (!multipv) return;
          const scoreToken = line.match(
            / score (?<value>cp -?\d+|mate -?\d+)/,
          )?.groups?.value;
          const pv = line.match(/ pv (?<value>.+)$/)?.groups?.value;
          const n = Number(multipv);
          const previous = byPv.get(n);
          const score = scoreToken
            ? parseScore(scoreToken)
            : {
                cp: previous?.scoreCp ?? null,
                mate: previous?.scoreMate ?? null,
              };
          byPv.set(n, {
            multipv: n,
            scoreCp: score.cp,
            scoreMate: score.mate,
            wdl: parseWdl(line) ?? previous?.wdl ?? null,
            pv: pv ? pv.split(" ") : (previous?.pv ?? []),
          });
        } else if (line.startsWith("bestmove")) {
          if (cancellation) fail(cancellation, false);
          else succeed();
        }
      };

      session.aborts.add(abort);
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
    if (session.initSettled) return;
    session.initSettled = true;
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
    if (!session.initSettled) {
      session.initSettled = true;
      session.reject(error);
    }
    const aborts = [...session.aborts];
    session.aborts.clear();
    if (session.engine) {
      session.engine.listener = null;
      this.terminate(session.engine);
    }
    for (const abort of aborts) abort(error);
  }

  private terminate(engine: StockfishEngine): void {
    if (this.terminated.has(engine)) return;
    this.terminated.add(engine);
    engine.listener = null;
    try {
      engine.terminate();
    } catch {}
  }

  async quit(): Promise<void> {
    this.quitGeneration++;
    const session = this.session;
    if (session) this.invalidateSession(session, new Error("stockfish quit"));
  }
}

export const stockfish = new Stockfish();
