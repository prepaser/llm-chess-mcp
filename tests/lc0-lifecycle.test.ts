import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Chess } from "chess.js";
import { createEngineAnalyzer } from "../src/engines/analysis.js";
import { Lc0, type Lc0Manifest, type Lc0Process } from "../src/engines/lc0.js";

const FEN = "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";
const REQUEST = { mode: "lc0" as const, depth: 10, multipv: 1, movetimeMs: 10 };
const WDL = "500 400 100";

type Deferred<T = void> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

type FakeOptions = {
  handshake?: "normal" | "hang";
  analysis?: "normal" | "hang" | "scoreless" | "empty" | "delayed" | "stop-hang";
  analysisDelayMs?: number;
  epipe?: boolean;
  oversizedOutput?: boolean;
  exitOnKill?: "any" | "sigkill" | "never";
};

class FakeLc0Process extends EventEmitter implements Lc0Process {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new FakeStdin(this);
  readonly commands: string[] = [];
  readonly goStarted = deferred();
  readonly handshakeStarted = deferred();
  readonly stopSent = deferred();
  readonly quitSent = deferred();
  readonly exitEvent = deferred<void>();
  readonly kills: Array<NodeJS.Signals | number | undefined> = [];
  readonly epipe: boolean;
  private exited = false;

  constructor(private readonly options: FakeOptions = {}) {
    super();
    this.epipe = options.epipe ?? false;
  }

  command(value: string): void {
    this.commands.push(value);
    if (value === "uci") {
      this.handshakeStarted.resolve();
      if (this.options.oversizedOutput) {
        queueMicrotask(() => this.stdout.emit("data", "x".repeat(1_048_577)));
      } else if (this.options.handshake !== "hang") {
        queueMicrotask(() => this.stdout.emit("data", "id name Lc0 v0.32.1\noption name MultiPV type spin\noption name UCI_ShowWDL type check\noption name ScoreType type combo var centipawn\nuciok\n"));
      }
    } else if (value === "isready" && this.options.handshake !== "hang") {
      queueMicrotask(() => this.stdout.emit("data", "readyok\n"));
    } else if (value.startsWith("go movetime")) {
      this.goStarted.resolve();
      if (this.options.analysis === "normal" || this.options.analysis === undefined) {
        queueMicrotask(() => this.stdout.emit("data", `info multipv 1 score cp 31 wdl ${WDL} pv e2e4 e7e5\nbestmove e2e4\n`));
      } else if (this.options.analysis === "scoreless") {
        queueMicrotask(() => this.stdout.emit("data", `info multipv 1 score cp 42 wdl 600 300 100 pv e2e4 e7e5\ninfo multipv 1 pv e2e4 c7c5\nbestmove e2e4\n`));
      } else if (this.options.analysis === "empty") {
        queueMicrotask(() => this.stdout.emit("data", "bestmove e2e4\n"));
      } else if (this.options.analysis === "delayed") {
        setTimeout(() => this.stdout.emit("data", `info multipv 1 score cp 31 wdl ${WDL} pv e2e4 e7e5\nbestmove e2e4\n`), this.options.analysisDelayMs ?? 10);
      }
    } else if (value === "stop") {
      this.stopSent.resolve();
      if (this.options.analysis !== "stop-hang") queueMicrotask(() => this.stdout.emit("data", "bestmove e2e4\n"));
    } else if (value === "quit") {
      this.quitSent.resolve();
    }
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal);
    if (this.options.exitOnKill === "any" || (this.options.exitOnKill === "sigkill" && signal === "SIGKILL")) {
      queueMicrotask(() => this.emitExit(0, null));
    }
    return true;
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code, signal);
    this.exitEvent.resolve();
  }
}

class FakeStdin extends EventEmitter {
  constructor(private readonly process: FakeLc0Process) {
    super();
  }

  write(data: string): boolean {
    if (this.process.epipe) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    for (const command of data.trimEnd().split("\n")) this.process.command(command);
    return true;
  }

}

async function fixture(t: test.TestContext): Promise<{ root: string; manifest: Lc0Manifest }> {
  const root = await mkdtemp(join(tmpdir(), "llm-chess-lc0-lifecycle-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "lc0"), "binary");
  await writeFile(join(root, "weights.pb"), "weights");
  return {
    root,
    manifest: {
      schemaVersion: 1,
      engineVersion: "0.32.1",
      weights: { path: "weights.pb", sha256: "a".repeat(64) },
      platforms: { [`${process.platform}-${process.arch}`]: { executable: "lc0", backend: "dnnl" } },
    },
  };
}

test("abort during handshake promptly settles and terminates the process", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let child!: FakeLc0Process;
  const spawned = deferred<FakeLc0Process>();
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { child = new FakeLc0Process({ handshake: "hang", exitOnKill: "any" }); spawned.resolve(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const controller = new AbortController();
  const analysis = engine.analyze(FEN, REQUEST, [], controller.signal);
  await spawned.promise;
  controller.abort(new Error("operation aborted"));
  await assert.rejects(analysis, /operation aborted/);
  assert.ok(child.kills.length > 0);
  await engine.quit();
});

test("abort queued analysis does not start a second process", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  const children: FakeLc0Process[] = [];
  const spawned = deferred<FakeLc0Process>();
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { const child = new FakeLc0Process({ handshake: "hang", exitOnKill: "any" }); children.push(child); spawned.resolve(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const first = engine.analyze(FEN, REQUEST);
  await spawned.promise;
  const controller = new AbortController();
  const queued = engine.analyze(FEN, REQUEST, [], controller.signal);
  controller.abort(new Error("queued cancellation"));
  await assert.rejects(queued, /queued cancellation/);
  assert.equal(children.length, 1);
  const quitting = engine.quit();
  await assert.rejects(first);
  await quitting;
});

test("active abort sends stop and escalates to SIGKILL after the stop grace", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let child!: FakeLc0Process;
  const spawned = deferred<FakeLc0Process>();
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { child = new FakeLc0Process({ analysis: "stop-hang", exitOnKill: "sigkill" }); spawned.resolve(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const controller = new AbortController();
  const analysis = engine.analyze(FEN, REQUEST, [], controller.signal);
  await spawned.promise;
  await child.goStarted.promise;
  controller.abort(new Error("active cancellation"));
  await child.stopSent.promise;
  await assert.rejects(analysis, /active cancellation/);
  assert.ok(child.kills.includes("SIGKILL"));
  await engine.quit();
});

test("quit during handshake waits for exit and rejects queued work", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let child!: FakeLc0Process;
  const spawned = deferred<FakeLc0Process>();
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { child = new FakeLc0Process({ handshake: "hang", exitOnKill: "never" }); spawned.resolve(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const active = engine.analyze(FEN, REQUEST);
  await spawned.promise;
  const queued = engine.analyze(FEN, REQUEST);
  const quitting = engine.quit();
  let quitSettled = false;
  void quitting.then(() => { quitSettled = true; });
  await child.quitSent.promise;
  assert.equal(quitSettled, false);
  child.emitExit(0, null);
  await assert.rejects(active, /Lc0 process exited|exited before completion|lc0 quit/);
  await assert.rejects(queued, /lc0 quit/);
  await quitting;
});

test("quit during analysis waits for exit and rejects queued work", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let child!: FakeLc0Process;
  const spawned = deferred<FakeLc0Process>();
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { child = new FakeLc0Process({ analysis: "hang", exitOnKill: "never" }); spawned.resolve(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const active = engine.analyze(FEN, REQUEST);
  await spawned.promise;
  await child.goStarted.promise;
  const queued = engine.analyze(FEN, REQUEST);
  const quitting = engine.quit();
  let quitSettled = false;
  void quitting.then(() => { quitSettled = true; });
  await child.quitSent.promise;
  assert.equal(quitSettled, false);
  child.emitExit(0, null);
  await assert.rejects(active, /Lc0 process exited|lc0 quit/);
  await assert.rejects(queued, /lc0 quit/);
  await quitting;
});

test("unexpected exit causes the next request to respawn Lc0", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  const children: FakeLc0Process[] = [];
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { const child = new FakeLc0Process({ analysis: "normal", exitOnKill: "any" }); children.push(child); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  await engine.analyze(FEN, REQUEST);
  children[0]!.emitExit(1, null);
  await engine.analyze(FEN, REQUEST);
  assert.equal(children.length, 2);
  await engine.quit();
});

test("scoreless PV updates preserve the previous score and WDL", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => new FakeLc0Process({ analysis: "scoreless", exitOnKill: "any" }), timeouts: { handshake: 50, stopGrace: 5 } });
  const [line] = await engine.analyze(FEN, REQUEST);
  assert.deepEqual(line, { multipv: 1, scoreCp: 42, scoreMate: null, wdl: [600, 300, 100], pv: ["e2e4", "c7c5"] });
  await engine.quit();
});

test("oversized stdout and EPIPE reject without uncaught process errors", { timeout: 500 }, async (t) => {
  const oversized = await fixture(t);
  const oversizedChild = new FakeLc0Process({ oversizedOutput: true, exitOnKill: "any" });
  const oversizedEngine = new Lc0({ manifest: oversized.manifest, manifestPath: join(oversized.root, "manifest.json"), spawn: () => oversizedChild, timeouts: { handshake: 50, stopGrace: 5 } });
  await assert.rejects(oversizedEngine.analyze(FEN, REQUEST), /output exceeded limit/);
  await oversizedEngine.quit();

  const epipe = await fixture(t);
  const epipeChild = new FakeLc0Process({ epipe: true, exitOnKill: "any" });
  const epipeEngine = new Lc0({ manifest: epipe.manifest, manifestPath: join(epipe.root, "manifest.json"), spawn: () => epipeChild, timeouts: { handshake: 50, stopGrace: 5 } });
  await assert.rejects(epipeEngine.analyze(FEN, REQUEST), /EPIPE/);
  await epipeEngine.quit();
});

test("terminal positions return no lines without starting Lc0", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let spawns = 0;
  const engine = new Lc0({
    manifest,
    manifestPath: join(root, "manifest.json"),
    spawn: () => { spawns += 1; return new FakeLc0Process(); },
  });
  const request = { ...REQUEST, movetimeMs: 1 };
  const checkmate = "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1";
  const stalemate = "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1";
  const repetition = ["g1f3", "g8f6", "f3g1", "f6g8", "g1f3", "g8f6", "f3g1", "f6g8"];
  assert.deepEqual(await engine.analyze(checkmate, request), []);
  assert.deepEqual(await engine.analyze(stalemate, request), []);
  assert.deepEqual(await engine.analyze(FEN.replace(" b KQkq - 0 1", " w KQkq - 0 1"), request, repetition), []);
  assert.equal(spawns, 0);
  await engine.quit();
});

test("metadata reads the manifest without starting Lc0", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let spawns = 0;
  const engine = new Lc0({
    manifest,
    manifestPath: join(root, "manifest.json"),
    spawn: () => { spawns += 1; return new FakeLc0Process(); },
  });
  assert.deepEqual(await engine.metadata(), {
    id: "lc0",
    version: "0.32.1",
    weightsSha256: "a".repeat(64),
    backend: "dnnl",
  });
  assert.equal(spawns, 0);
  await engine.quit();
});

test("analysis watchdog allows the complete requested movetime plus stop grace", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  const engine = new Lc0({
    manifest,
    manifestPath: join(root, "manifest.json"),
    spawn: () => new FakeLc0Process({ analysis: "delayed", analysisDelayMs: 10, exitOnKill: "any" }),
    timeouts: { analyze: 30, handshake: 50, stopGrace: 5 },
  });
  const lines = await engine.analyze(FEN, { ...REQUEST, movetimeMs: 20 });
  assert.equal(lines[0]?.scoreCp, 31);
  await engine.quit();
});

test("analysis watchdog respects search limits and adds bounded stop grace", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  for (const [movetimeMs, analyze, stopGrace, expected] of [
    [30_000, 30_000, 5, 30_005],
    [100, 30_000, 5, 105],
    [100, 50, 5, 55],
    [30_000, 30_000, 2_147_483_647, 2_147_483_647],
  ] as const) {
    const delays: number[] = [];
    const child = new FakeLc0Process({ exitOnKill: "any" });
    const engine = new Lc0({
      manifest,
      manifestPath: join(root, "manifest.json"),
      spawn: () => child,
      timeouts: { handshake: 50, analyze, stopGrace },
      timers: {
        setTimeout: (callback, delay) => {
          delays.push(delay);
          return setTimeout(callback, delay);
        },
      },
    });
    try {
      await engine.analyze(FEN, { ...REQUEST, movetimeMs });
    } finally {
      child.emitExit(0, null);
      await engine.quit();
    }
    assert.ok(delays.includes(expected), `missing watchdog delay ${expected}`);
  }
});

test("an ongoing position with no analysis lines is rejected", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => new FakeLc0Process({ analysis: "empty", exitOnKill: "any" }), timeouts: { handshake: 50, stopGrace: 5 } });
  await assert.rejects(engine.analyze(FEN, REQUEST), /returned no analysis lines/);
  await engine.quit();
});

test("invalid FEN, history, and request are rejected before spawning", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let spawns = 0;
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { spawns++; return new FakeLc0Process(); } });
  await assert.rejects(engine.analyze("invalid fen", REQUEST), /FEN|invalid/i);
  await assert.rejects(engine.analyze(FEN, null as never), /request/);
  await assert.rejects(engine.analyze(FEN, REQUEST, "e2e4" as never), /history/);
  await assert.rejects(engine.analyze(FEN, REQUEST, ["not-a-move"]), /history|move/i);
  assert.equal(spawns, 0);
  await engine.quit();
});

test("analysis arguments and history are snapshotted at admission", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let child!: FakeLc0Process;
  const engine = new Lc0({ manifest, manifestPath: join(root, "manifest.json"), spawn: () => { child = new FakeLc0Process({ exitOnKill: "any" }); return child; }, timeouts: { handshake: 50, stopGrace: 5 } });
  const request = { ...REQUEST, multipv: 1, movetimeMs: 11 };
  const history = ["e7e5"];
  const analysis = engine.analyze(FEN, request, history);
  request.multipv = 3;
  request.movetimeMs = 999;
  history[0] = "d7d5";
  await analysis;
  assert.ok(child.commands.includes("setoption name MultiPV value 1"));
  assert.ok(child.commands.includes("go movetime 11"));
  assert.ok(child.commands.includes(`position fen ${FEN} moves e7e5`));
  await engine.quit();
});

test("terminal metadata does not share an aborting handshake", { timeout: 500 }, async (t) => {
  const { root, manifest } = await fixture(t);
  let spawns = 0;
  const child = new FakeLc0Process({ handshake: "hang", exitOnKill: "any" });
  const engine = new Lc0({
    manifest,
    manifestPath: join(root, "manifest.json"),
    spawn: () => {
      spawns += 1;
      return child;
    },
    timeouts: { handshake: 200, stopGrace: 5 },
  });
  const analyzer = createEngineAnalyzer({
    lc0: {
      id: "lc0",
      analyze: (position, request, signal) => engine.analyze(position.initialFen, request, position.moves, signal),
      metadata: () => engine.metadata(),
      quit: () => engine.quit(),
    },
  });
  const controller = new AbortController();
  const ongoing = new Chess();
  ongoing.move("e4");
  const ongoingAnalysis = analyzer.analyzeEngines(ongoing, REQUEST, controller.signal);
  const cancelled = assert.rejects(ongoingAnalysis, /cancel A/);
  t.after(() => engine.quit());
  await child.handshakeStarted.promise;
  const terminal = new Chess("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1");
  const pendingTerminal = analyzer.analyzeEngines(terminal, REQUEST);
  await Promise.resolve();
  controller.abort(new Error("cancel A"));
  const terminalAnalysis = await pendingTerminal;
  assert.deepEqual(terminalAnalysis.enginesUsed, ["lc0"]);
  assert.equal(terminalAnalysis.engines.lc0.status, "ok");
  if (terminalAnalysis.engines.lc0.status === "ok") assert.deepEqual(terminalAnalysis.engines.lc0.meta, {
    id: "lc0",
    version: "0.32.1",
    weightsSha256: "a".repeat(64),
    backend: "dnnl",
  });
  await cancelled;
  assert.equal(spawns, 1);
  await analyzer.quitEngines();
  assert.ok(child.kills.length > 0);
});
