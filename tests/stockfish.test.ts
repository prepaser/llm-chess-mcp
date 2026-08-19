import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveStockfishFlavor,
  Stockfish,
  type StockfishEngine,
  type StockfishInit,
} from "../src/engines/stockfish.js";

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

test("initialization times out when its callback never arrives", async () => {
  const current = engine();
  const stockfish = new Stockfish({
    init: () => current,
    timeouts: { init: 10 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /init timeout/);
  assert.equal(current.terminations, 1);
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

test("analysis ignores malformed multipv lines and defaults missing fields", async () => {
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      queueMicrotask(() => {
        current.listener?.("info depth 1 multipv invalid score cp 999 pv a1a2");
        current.listener?.("info depth 1 multipv 1 score mate -3 pv e2e4");
        current.listener?.("info depth 1 multipv 2");
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
      wdl: null,
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
