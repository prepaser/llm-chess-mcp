import assert from "node:assert/strict";
import test from "node:test";
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
  assert.equal(
    parseAnalysisInfo("info depth 1 multipv invalid score cp 42 pv e2e4"),
    null,
  );
  assert.equal(parseAnalysisInfo("bestmove e2e4"), null);
});

test("initialization times out when its callback never arrives", async () => {
  const current = engine();
  const stockfish = new Stockfish({
    init: () => current,
    timeouts: { init: 10 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /init timeout/);
  assert.equal(current.terminations, 1);
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
  assert.equal(returned.terminations, 1);

  callback(null, late);
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
  await stockfish.quit();
  await assert.rejects(pending, /stockfish quit/);
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
    timeouts: { init: 50, handshake: 50, analyze: 100 },
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

  await stockfish.quit();
  await assert.rejects(active, /stockfish quit/);
  await assert.rejects(queued, /request cancelled/);
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

test("quit cancels old queued work without blocking a new generation", async () => {
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  const first = respondingEngine(false);
  const originalSend = first.sendCommand.bind(first);
  first.sendCommand = (command) => {
    originalSend(command);
    if (command.startsWith("go depth ")) analysisStarted();
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
  await stockfish.quit();

  await assert.rejects(active, /stockfish quit/);
  await assert.rejects(oldQueued, /request cancelled/);
  assert.equal(initCalls, 1);
  assert.equal(first.terminations, 1);

  assert.equal((await stockfish.analyze("new", 1, 1))[0]?.scoreCp, 42);
  assert.equal(initCalls, 2);
});
