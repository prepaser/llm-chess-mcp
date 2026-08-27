import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  resolveStockfishFlavor,
  Stockfish,
  type StockfishEngine,
  type StockfishInit,
} from "../src/engines/stockfish.js";
import {
  mergeAnalysisInfo,
  parseAnalysisInfo,
} from "../src/engines/stockfish-info.js";

const execFileAsync = promisify(execFile);

function nextImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function engine(
  onCommand: (engine: StockfishEngine, command: string) => void = () => {},
): StockfishEngine & { commands: string[]; terminations: number } {
  return {
    listener: null,
    commands: [],
    terminations: 0,
    sendCommand(command) {
      this.commands.push(command);
      onCommand(this, command);
    },
    terminate() {
      this.terminations++;
    },
  };
}

function respondingEngine(respondToAnalysis: boolean): ReturnType<typeof engine> {
  return engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (respondToAnalysis && command.startsWith("go depth ")) {
      queueMicrotask(() => {
        current.listener?.(
          "info depth 1 multipv 1 score cp 42 wdl 500 400 100 pv e2e4 e7e5",
        );
        current.listener?.("bestmove e2e4");
      });
    }
  });
}

function initializer(engines: StockfishEngine[]): StockfishInit {
  return (_flavor, callback) => {
    const current = engines.shift();
    if (!current) throw new Error("no fake engine");
    queueMicrotask(() => callback(null, current));
    return current;
  };
}

test("resolveStockfishFlavor accepts package keywords and rejects paths", () => {
  assert.equal(resolveStockfishFlavor(undefined), "lite-single");
  assert.equal(resolveStockfishFlavor("FULL"), "full");
  assert.equal(resolveStockfishFlavor("single-lite"), "single-lite");
  assert.throws(
    () => resolveStockfishFlavor("../../tmp/engine.js"),
    /invalid STOCKFISH_FLAVOR/,
  );
});

test("analysis info parser merges partial updates and resets scores", () => {
  const mate = parseAnalysisInfo(
    "info depth 1 multipv 1 score mate -3 wdl 100 200 700",
  );
  assert.ok(mate);
  const withMate = mergeAnalysisInfo(undefined, mate);
  assert.deepEqual(withMate, {
    multipv: 1,
    scoreCp: null,
    scoreMate: -3,
    wdl: [100, 200, 700],
    pv: [],
  });

  const pv = parseAnalysisInfo("info depth 2 multipv 1 pv e2e4 e7e5");
  assert.ok(pv);
  const withPv = mergeAnalysisInfo(withMate, pv);
  assert.deepEqual(withPv, {
    ...withMate,
    pv: ["e2e4", "e7e5"],
  });

  const cp = parseAnalysisInfo("info depth 3 multipv 1 score cp 42");
  assert.ok(cp);
  assert.deepEqual(mergeAnalysisInfo(withPv, cp), {
    ...withPv,
    scoreCp: 42,
    scoreMate: null,
  });
  assert.deepEqual(parseAnalysisInfo("info depth 0 score mate 0"), {
    multipv: 1,
    score: { cp: null, mate: 0 },
  });
  assert.deepEqual(parseAnalysisInfo("info depth 0 score cp 0"), {
    multipv: 1,
    score: { cp: 0, mate: null },
  });
  assert.equal(parseAnalysisInfo("info depth 1 score cp 0"), null);
  assert.equal(parseAnalysisInfo("information depth 0 score cp 0"), null);
  assert.equal(
    parseAnalysisInfo("info depth 0 multipv invalid score mate 0"),
    null,
  );
  assert.equal(
    parseAnalysisInfo("info depth 1 multipv invalid score cp 42 pv e2e4"),
    null,
  );
  assert.equal(parseAnalysisInfo("info depth 1 multipv 0 score cp 42"), null);
  assert.equal(
    parseAnalysisInfo("info depth 1 multipv 1oops score cp 42 pv e2e4"),
    null,
  );
  assert.equal(
    parseAnalysisInfo(`info depth 1 multipv ${"9".repeat(400)} score cp 42`),
    null,
  );
  assert.ok(parseAnalysisInfo("info depth 1 multipv 256 score cp 100000"));
  assert.equal(parseAnalysisInfo("info depth 1 multipv 257 score cp 42"), null);

  const boundedNumbers = parseAnalysisInfo(
    "info depth 4 multipv 1 score cp 100001 wdl 1001 0 0 pv d2d4",
  );
  assert.ok(boundedNumbers);
  assert.deepEqual(boundedNumbers, { multipv: 1, pv: ["d2d4"] });
  const invalidWdlTotal = parseAnalysisInfo(
    "info depth 4 multipv 1 score mate -100001 wdl 1 2 3 pv d2d4",
  );
  assert.ok(invalidWdlTotal);
  assert.deepEqual(invalidWdlTotal, { multipv: 1, pv: ["d2d4"] });

  const malformedNumbers = parseAnalysisInfo(
    `info depth 4 multipv 1 score cp ${"9".repeat(400)} wdl ${"9".repeat(400)} 0 0 pv d2d4`,
  );
  assert.ok(malformedNumbers);
  assert.deepEqual(mergeAnalysisInfo(withPv, malformedNumbers), {
    ...withPv,
    pv: ["d2d4"],
  });
  const malformedSuffixes = parseAnalysisInfo(
    "info depth 4 multipv 1 score cp 42oops wdl 1 2 3oops pv d2d4",
  );
  assert.ok(malformedSuffixes);
  assert.deepEqual(mergeAnalysisInfo(withPv, malformedSuffixes), {
    ...withPv,
    pv: ["d2d4"],
  });
  assert.equal(parseAnalysisInfo("bestmove e2e4"), null);
});

test("initialization times out when its callback never arrives", async () => {
  const current = engine();
  const stockfish = new Stockfish({
    init: () => current,
    timeouts: { init: 10 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /init timeout/);
  await nextImmediate();
  assert.equal(current.terminations, 1);
});

test("quit waits for a cold dependency before terminating it", async () => {
  let initialized!: () => void;
  let initializationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    initializationStarted = resolve;
  });
  const commands: string[] = [];
  let terminations = 0;
  const current = {
    listener: null,
    terminate() {
      terminations++;
    },
  } as unknown as StockfishEngine;
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      initialized = () => {
        current.sendCommand = (command) => commands.push(command);
        callback(null, current);
      };
      initializationStarted();
      return current;
    },
    timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 10 },
  });

  const active = stockfish.analyze("fen", 1, 1);
  const outcome = active.catch((error: unknown) => error);
  await started;
  const quitting = stockfish.quit();
  let quitSettled = false;
  void quitting.then(() => {
    quitSettled = true;
  });
  await nextImmediate();
  assert.equal(quitSettled, false);
  assert.equal(terminations, 0);

  initialized();
  await quitting;
  assert.match(String(await outcome), /stockfish quit/);
  assert.deepEqual(commands, ["quit"]);
  assert.equal(terminations, 1);
  assert.notEqual(current.listener, null);
});

test("cold dependency teardown is bounded when readiness never arrives", async () => {
  let terminations = 0;
  const current = {
    listener: null,
    terminate() {
      terminations++;
    },
  } as unknown as StockfishEngine;
  const stockfish = new Stockfish({
    init: () => current,
    timeouts: { init: 5, handshake: 50, analyze: 50, stopGrace: 5 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /init timeout/);
  const started = performance.now();
  await stockfish.quit();
  assert.ok(performance.now() - started < 100);
  assert.equal(terminations, 1);
  assert.notEqual(current.listener, null);
});

test("synchronous initialization callback completes the handshake", async () => {
  const current = respondingEngine(true);
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      callback(null, current);
      return current;
    },
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });

  assert.equal((await stockfish.analyze("fen", 1, 1))[0]?.scoreCp, 42);
});

test("synchronous initialization callback terminates a distinct returned engine", async () => {
  const returned = engine();
  const initialized = respondingEngine(true);
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      callback(null, initialized);
      return returned;
    },
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });

  assert.equal((await stockfish.analyze("fen", 1, 1))[0]?.scoreCp, 42);
  await nextImmediate();
  assert.equal(returned.terminations, 1);
  assert.equal(initialized.terminations, 0);
  await stockfish.quit();
  assert.equal(initialized.terminations, 1);
});

test("initialization callback failure terminates its engine and reinitializes queued work", async () => {
  const first = engine();
  const second = respondingEngine(true);
  let attempt = 0;
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      const current = attempt++ === 0 ? first : second;
      queueMicrotask(() =>
        callback(current === first ? new Error("init failed") : null, current),
      );
      return current;
    },
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });

  const failed = stockfish.analyze("first", 1, 1);
  const queued = stockfish.analyze("second", 1, 1);

  await assert.rejects(failed, /init failed/);
  assert.equal((await queued)[0]?.scoreCp, 42);
  assert.equal(first.terminations, 1);
  assert.equal(second.terminations, 0);
});

test("late initialization callbacks terminate their delivered engine", async () => {
  let callback!: (error: Error | null, current: StockfishEngine) => void;
  const returned = engine();
  const late = engine();
  const stockfish = new Stockfish({
    init: (_flavor, initCallback) => {
      callback = initCallback;
      return returned;
    },
    timeouts: { init: 5 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /init timeout/);
  await nextImmediate();
  assert.equal(returned.terminations, 1);

  callback(null, late);
  await nextImmediate();
  assert.equal(late.terminations, 1);
});

test("initialization callback replaces the returned engine", async () => {
  const returned = engine();
  const initialized = respondingEngine(true);
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      queueMicrotask(() => callback(null, initialized));
      return returned;
    },
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });

  assert.equal((await stockfish.analyze("fen", 1, 1))[0]?.scoreCp, 42);
  await nextImmediate();
  assert.equal(returned.terminations, 1);
  assert.equal(initialized.terminations, 0);
});

test("analyze timeout resets the engine and queued work reinitializes", async () => {
  const first = respondingEngine(false);
  const second = respondingEngine(true);
  const stockfish = new Stockfish({
    init: initializer([first, second]),
    timeouts: { init: 50, handshake: 50, analyze: 5, stopGrace: 5 },
  });

  const timedOut = stockfish.analyze("first", 1, 1);
  const queued = stockfish.analyze("second", 1, 1);

  await assert.rejects(timedOut, /analyze timeout/);
  assert.deepEqual(await queued, [
    {
      multipv: 1,
      scoreCp: 42,
      scoreMate: null,
      wdl: [500, 400, 100],
      pv: ["e2e4", "e7e5"],
    },
  ]);
  assert.equal(first.terminations, 1);
  assert.equal(second.terminations, 0);
});

test("analyze timeout rejects but reuses an engine that stops cleanly", async () => {
  let initCalls = 0;
  let analyses = 0;
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      analyses++;
      if (analyses === 2) {
        queueMicrotask(() => {
          current.listener?.("info depth 1 multipv 1 score cp 42 pv e2e4");
          current.listener?.("bestmove e2e4");
        });
      }
    } else if (command === "stop") {
      queueMicrotask(() => current.listener?.("bestmove e2e4"));
    }
  });
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      initCalls++;
      queueMicrotask(() => callback(null, current));
      return current;
    },
    timeouts: { init: 50, handshake: 50, analyze: 5, stopGrace: 50 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /analyze timeout/);
  assert.equal((await stockfish.analyze("next", 1, 1))[0]?.scoreCp, 42);
  assert.equal(current.commands.filter((command) => command === "stop").length, 1);
  assert.equal(initCalls, 1);
  assert.equal(current.terminations, 0);
});

test("analysis merges partial UCI updates, sorts ranks, and ignores malformed lines", async () => {
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      queueMicrotask(() => {
        current.listener?.("info depth 1 multipv invalid score cp 999 pv a1a2");
        current.listener?.("info depth 1 multipv 2");
        current.listener?.(
          "info depth 1 multipv 1 score mate -3 wdl 100 200 700 pv e2e4",
        );
        current.listener?.("info depth 2 multipv 1 pv e2e4");
        current.listener?.("bestmove e2e4");
      });
    }
  });
  const stockfish = new Stockfish({
    init: initializer([current]),
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });

  assert.deepEqual(await stockfish.analyze("fen", 1, 2), [
    {
      multipv: 1,
      scoreCp: null,
      scoreMate: -3,
      wdl: [100, 200, 700],
      pv: ["e2e4"],
    },
    {
      multipv: 2,
      scoreCp: null,
      scoreMate: null,
      wdl: null,
      pv: [],
    },
  ]);
});

test("handshake failure terminates its engine and queued work reinitializes", async () => {
  const first = engine();
  const second = respondingEngine(true);
  const stockfish = new Stockfish({
    init: initializer([first, second]),
    timeouts: { init: 50, handshake: 10 },
  });

  const failed = stockfish.analyze("first", 1, 1);
  const queued = stockfish.analyze("second", 1, 1);

  await assert.rejects(failed, /handshake timeout/);
  assert.equal((await queued)[0]?.scoreCp, 42);
  assert.equal(first.terminations, 1);
  assert.equal(second.terminations, 0);
});

test("queue capacity fails fast", async () => {
  const current = engine();
  const stockfish = new Stockfish({
    init: () => current,
    maxQueue: 1,
    timeouts: { init: 50 },
  });

  const pending = stockfish.analyze("first", 1, 1);
  await assert.rejects(stockfish.analyze("second", 1, 1), /queue full/);
  const pendingOutcome = pending.catch((error: unknown) => error);
  await stockfish.quit();
  assert.match(String(await pendingOutcome), /stockfish quit/);
});

test("pre-aborted analysis does not enter the queue or initialize Stockfish", async () => {
  const controller = new AbortController();
  controller.abort();
  let initCalls = 0;
  const stockfish = new Stockfish({
    init: () => {
      initCalls++;
      return engine();
    },
  });

  await assert.rejects(
    stockfish.analyze("fen", 1, 1, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(initCalls, 0);
});

test("queued abort releases capacity and skips its UCI work", async () => {
  let analysisStarted!: () => void;
  let emitBestmove!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  let goCount = 0;
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      goCount++;
      if (goCount === 1) {
        queueMicrotask(() => {
          current.listener?.("info depth 1 multipv 1 score cp 99 pv e2e4");
          analysisStarted();
        });
      } else {
        queueMicrotask(() => {
          current.listener?.("info depth 1 multipv 1 score cp 42 pv d2d4");
          current.listener?.("bestmove d2d4");
        });
      }
    } else if (command === "stop") {
      emitBestmove = () => current.listener?.("bestmove e2e4");
    }
  });
  const stockfish = new Stockfish({
    init: initializer([current]),
    maxQueue: 2,
    timeouts: { init: 50, handshake: 50, analyze: 100, stopGrace: 50 },
  });
  const activeController = new AbortController();
  const queuedController = new AbortController();
  const active = stockfish.analyze("active", 1, 1, activeController.signal);
  let activeSettled = false;
  const activeOutcome = active.then(
    () => null,
    (error: unknown) => {
      activeSettled = true;
      return error;
    },
  );
  await started;
  const cancelled = stockfish.analyze("cancelled", 1, 1, queuedController.signal);
  queuedController.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  const next = stockfish.analyze("next", 1, 1);
  activeController.abort();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(activeSettled, false);
  assert.equal(current.commands.filter((command) => command === "stop").length, 1);
  assert.equal(current.commands.includes("position fen cancelled"), false);
  assert.equal(current.commands.includes("position fen next"), false);

  emitBestmove();
  const cancellation = await activeOutcome;
  assert.ok(cancellation instanceof Error);
  assert.equal(cancellation.name, "AbortError");
  assert.equal((await next)[0]?.scoreCp, 42);
  assert.equal(current.commands.includes("position fen cancelled"), false);
});

test("cancelled queued requests are removed instead of accumulating behind active work", async () => {
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      analysisStarted();
    }
  });
  const stockfish = new Stockfish({
    init: initializer([current]),
    maxQueue: 2,
    timeouts: { init: 50, handshake: 50, analyze: 100, stopGrace: 5 },
  });
  const active = stockfish.analyze("active", 1, 1);
  await started;

  for (let index = 0; index < 32; index++) {
    const controller = new AbortController();
    const cancelled = stockfish.analyze(
      `cancelled-${index}`,
      1,
      1,
      controller.signal,
    );
    controller.abort();
    await assert.rejects(cancelled, { name: "AbortError" });
  }

  const queued = stockfish.analyze("queued", 1, 1);
  await assert.rejects(stockfish.analyze("overflow", 1, 1), /queue full/);
  assert.equal(
    (stockfish as unknown as { queue: unknown[] }).queue.length,
    1,
  );
  assert.equal(
    current.commands.some((command) => command.startsWith("position fen cancelled-")),
    false,
  );

  const activeOutcome = active.catch((error: unknown) => error);
  const queuedOutcome = queued.catch((error: unknown) => error);
  await stockfish.quit();
  assert.match(String(await activeOutcome), /stockfish quit/);
  assert.match(String(await queuedOutcome), /request cancelled/);
});

test("abort during cold initialization releases capacity without resetting the session", async () => {
  let initialized!: () => void;
  let initializationStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    initializationStarted = resolve;
  });
  let initCalls = 0;
  const current = respondingEngine(true);
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      initCalls++;
      initialized = () => callback(null, current);
      initializationStarted();
      return current;
    },
    maxQueue: 1,
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });
  const controller = new AbortController();
  const cancelled = stockfish.analyze("cancelled", 1, 1, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  const next = stockfish.analyze("next", 1, 1);
  initialized();
  assert.equal((await next)[0]?.scoreCp, 42);
  assert.equal(initCalls, 1);
  assert.equal(current.terminations, 0);
  assert.equal(current.commands.includes("position fen cancelled"), false);
});

test("abort during handshake preserves the shared initialization", async () => {
  let uciSent!: () => void;
  const sent = new Promise<void>((resolve) => {
    uciSent = resolve;
  });
  let initCalls = 0;
  const current = engine((current, command) => {
    if (command === "uci") {
      uciSent();
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      queueMicrotask(() => {
        current.listener?.("info depth 1 multipv 1 score cp 42 pv e2e4");
        current.listener?.("bestmove e2e4");
      });
    }
  });
  const stockfish = new Stockfish({
    init: (flavor, callback) => {
      initCalls++;
      return initializer([current])(flavor, callback);
    },
    maxQueue: 1,
    timeouts: { init: 50, handshake: 50, analyze: 50 },
  });
  const controller = new AbortController();
  const cancelled = stockfish.analyze("cancelled", 1, 1, controller.signal);
  await sent;
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });

  const next = stockfish.analyze("next", 1, 1);
  current.listener?.("uciok");
  assert.equal((await next)[0]?.scoreCp, 42);
  assert.equal(initCalls, 1);
  assert.equal(current.terminations, 0);
  assert.equal(current.commands.includes("position fen cancelled"), false);
});

test("active abort invalidates after stop grace and queued work reinitializes", async () => {
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  const first = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      analysisStarted();
    }
  });
  const second = respondingEngine(true);
  const stockfish = new Stockfish({
    init: initializer([first, second]),
    timeouts: { init: 50, handshake: 50, analyze: 100, stopGrace: 5 },
  });
  const controller = new AbortController();
  const active = stockfish.analyze("active", 1, 1, controller.signal);
  const queued = stockfish.analyze("queued", 1, 1);
  await started;
  controller.abort();

  await assert.rejects(active, { name: "AbortError" });
  assert.equal(first.commands.filter((command) => command === "stop").length, 1);
  assert.equal((await queued)[0]?.scoreCp, 42);
  assert.equal(first.terminations, 1);
  assert.equal(second.terminations, 0);
});

test("quit drains old work before starting a new generation", async () => {
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  const first = respondingEngine(false);
  const originalSend = first.sendCommand.bind(first);
  first.sendCommand = (command) => {
    originalSend(command);
    if (command.startsWith("go depth ")) analysisStarted();
    else if (command === "stop") {
      queueMicrotask(() => first.listener?.("bestmove e2e4"));
    }
  };
  const second = respondingEngine(true);
  let initCalls = 0;
  const init = initializer([first, second]);
  const stockfish = new Stockfish({
    init: (flavor, callback) => {
      initCalls++;
      return init(flavor, callback);
    },
    maxQueue: 3,
    timeouts: { init: 50, handshake: 50, analyze: 50, stopGrace: 10 },
  });

  const active = stockfish.analyze("active", 1, 1);
  const oldQueued = stockfish.analyze("queued", 1, 1);
  await started;
  const activeOutcome = active.catch((error: unknown) => error);
  const queuedOutcome = oldQueued.catch((error: unknown) => error);
  const quitting = stockfish.quit();
  assert.equal(stockfish.quit(), quitting);
  await assert.rejects(stockfish.analyze("new", 1, 1), /shutting down/);
  assert.equal(initCalls, 1);
  await quitting;

  assert.match(String(await activeOutcome), /stockfish quit/);
  assert.match(String(await queuedOutcome), /request cancelled/);
  assert.equal(first.terminations, 1);
  assert.equal(first.commands.filter((command) => command === "stop").length, 1);
  assert.equal(first.commands.filter((command) => command === "quit").length, 1);
  assert.notEqual(first.listener, null);

  assert.equal((await stockfish.analyze("new", 1, 1))[0]?.scoreCp, 42);
  assert.equal(initCalls, 2);
});

test(
  "real lite-single quit stops active search without leaking stdout",
  { timeout: 15_000 },
  async () => {
    const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
    const source = `
      import { createRequire } from "node:module";
      import { Stockfish } from ${JSON.stringify(moduleUrl)};
      const consumerRequire = createRequire(import.meta.url);
      const cachedStockfish = consumerRequire("stockfish");
      const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      const stockfish = new Stockfish({
        flavor: "lite-single",
        timeouts: { init: 5000, handshake: 5000, analyze: 5000, stopGrace: 500 },
      });
      await stockfish.analyze(fen, 1, 1);
      const checkmate = await stockfish.analyze(
        "7k/6Q1/6K1/8/8/8/8/8 b - - 0 1",
        1,
        1,
      );
      const stalemate = await stockfish.analyze(
        "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1",
        1,
        1,
      );
      const active = stockfish.analyze(fen, 22, 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const started = performance.now();
      const outcome = active.then(
        () => "resolved",
        (error) => String(error),
      );
      await stockfish.quit();
      const elapsed = performance.now() - started;
      await new Promise((resolve) => setTimeout(resolve, 100));
      process.stdout.write(JSON.stringify({
        outcome: await outcome,
        elapsed,
        checkmate,
        stalemate,
        cacheIdentity: cachedStockfish === consumerRequire("stockfish"),
      }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
    );
    const result = JSON.parse(stdout) as {
      outcome: string;
      elapsed: number;
      checkmate: unknown;
      stalemate: unknown;
      cacheIdentity: boolean;
    };
    assert.match(result.outcome, /stockfish quit/);
    assert.ok(result.elapsed < 2_000, `quit took ${result.elapsed}ms`);
    assert.equal(result.cacheIdentity, true);
    assert.deepEqual(result.checkmate, [
      {
        multipv: 1,
        scoreCp: null,
        scoreMate: 0,
        wdl: null,
        pv: [],
      },
    ]);
    assert.deepEqual(result.stalemate, [
      {
        multipv: 1,
        scoreCp: 0,
        scoreMate: null,
        wdl: null,
        pv: [],
      },
    ]);
  },
);

test(
  "real worker-backed init timeout releases its MessagePort",
  { timeout: 15_000 },
  async () => {
    const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
    const source = `
      void (async () => {
        const { Stockfish } = await import(${JSON.stringify(moduleUrl)});
        const stockfish = new Stockfish({
          flavor: "lite",
          timeouts: { init: 1, handshake: 5000, analyze: 5000, stopGrace: 5000 },
        });
        const outcome = await stockfish
          .analyze(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            1,
            1,
          )
          .then(() => "resolved", (error) => String(error));
        await stockfish.quit();

        const cold = new Stockfish({
          flavor: "lite",
          timeouts: { init: 5000, handshake: 5000, analyze: 5000, stopGrace: 5000 },
        });
        const active = cold
          .analyze(
            "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            1,
            1,
          )
          .then(() => "resolved", (error) => String(error));
        await new Promise((resolve) => setTimeout(resolve, 1));
        await cold.quit();
        const quitOutcome = await active;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const handles = process
          ._getActiveHandles()
          .map((handle) => handle.constructor?.name);
        process.stdout.write(JSON.stringify({ outcome, quitOutcome, handles }));
      })();
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--eval", source],
      { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 },
    );
    const result = JSON.parse(stdout) as {
      outcome: string;
      quitOutcome: string;
      handles: string[];
    };
    assert.match(result.outcome, /stockfish init timeout/);
    assert.match(result.quitOutcome, /stockfish quit/);
    assert.equal(result.handles.includes("MessagePort"), false);
  },
);
