import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import {
  resolveStockfishFlavor,
  stockfish as defaultStockfish,
  Stockfish,
  type StockfishEngine,
  type StockfishInit,
  type StockfishOptions,
} from "../src/engines/stockfish.js";
import {
  mergeAnalysisInfo,
  parseAnalysisInfo,
} from "../src/engines/stockfish-info.js";
import { ChessError } from "../src/errors.js";

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

test("Stockfish timeouts fit the Node timer range", async () => {
  const names = ["init", "handshake", "analyze", "stopGrace"] as const;
  const invalid = [0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648];
  const warnings: Error[] = [];
  const onWarning = (warning: Error) => warnings.push(warning);
  process.on("warning", onWarning);
  try {
    assert.doesNotThrow(() => new Stockfish());
    for (const name of names) {
      assert.doesNotThrow(
        () => new Stockfish({ timeouts: { [name]: 2_147_483_647 } }),
      );
      for (const value of invalid) {
        assert.throws(
          () => new Stockfish({ timeouts: { [name]: value } }),
          new RegExp(`stockfish ${name} timeout must be a positive safe integer`),
        );
      }
    }
    await nextImmediate();
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(
    warnings.some((warning) => warning.name === "TimeoutOverflowWarning"),
    false,
  );
});

test("Stockfish ignores inherited outer options", () => {
  const inheritedInit: StockfishInit = () => {
    throw new Error("inherited init must not run");
  };
  const polluted = {
    init: inheritedInit,
    flavor: "asm",
    maxQueue: 1,
    timeouts: { init: 1, handshake: 1, analyze: 1, stopGrace: 1 },
  };
  const descriptors = new Map(
    Object.keys(polluted).map((name) => [
      name,
      Object.getOwnPropertyDescriptor(Object.prototype, name),
    ]),
  );
  try {
    for (const [name, value] of Object.entries(polluted)) {
      Object.defineProperty(Object.prototype, name, {
        configurable: true,
        value,
      });
    }
    for (const options of [{}, Object.create(polluted)] as StockfishOptions[]) {
      const current = new Stockfish(options) as unknown as {
        configuredFlavor: string | undefined;
        initEngine: StockfishInit | undefined;
        maxQueue: number;
        timeouts: Record<string, number>;
      };
      assert.equal(current.initEngine, undefined);
      assert.equal(current.configuredFlavor, undefined);
      assert.equal(current.maxQueue, 32);
      assert.deepEqual(current.timeouts, {
        init: 15_000,
        handshake: 15_000,
        analyze: 30_000,
        stopGrace: 2_000,
      });
    }
    const global = defaultStockfish as unknown as {
      configuredFlavor: string | undefined;
      initEngine: StockfishInit | undefined;
      maxQueue: number;
      timeouts: Record<string, number>;
    };
    assert.equal(global.initEngine, undefined);
    assert.equal(global.configuredFlavor, undefined);
    assert.equal(global.maxQueue, 32);
    assert.deepEqual(global.timeouts, {
      init: 15_000,
      handshake: 15_000,
      analyze: 30_000,
      stopGrace: 2_000,
    });
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else delete (Object.prototype as Record<string, unknown>)[name];
    }
  }
});

test("Stockfish accepts own options on normal and null-prototype objects", () => {
  for (const options of [
    {
      flavor: "asm",
      maxQueue: 3,
      timeouts: Object.assign(Object.create({ init: 1 }), { analyze: 7 }),
    },
    Object.assign(Object.create(null), {
      flavor: "asm",
      maxQueue: 3,
      timeouts: Object.assign(Object.create({ init: 1 }), { analyze: 7 }),
    }),
  ] as StockfishOptions[]) {
    const current = new Stockfish(options) as unknown as {
      configuredFlavor: string | undefined;
      maxQueue: number;
      timeouts: Record<string, number>;
    };
    assert.equal(current.configuredFlavor, "asm");
    assert.equal(current.maxQueue, 3);
    assert.deepEqual(current.timeouts, {
      init: 15_000,
      handshake: 15_000,
      analyze: 7,
      stopGrace: 2_000,
    });
  }
});

test("Stockfish honors non-enumerable own timeout fields", () => {
  const timeouts = Object.create({ handshake: 1 }) as Partial<
    Record<"init" | "handshake" | "analyze" | "stopGrace", number>
  >;
  Object.defineProperties(timeouts, {
    init: { value: 2, enumerable: false },
    analyze: { value: 3, enumerable: true },
  });

  const current = new Stockfish({ timeouts }) as unknown as {
    timeouts: Record<string, number>;
  };
  assert.deepEqual(current.timeouts, {
    init: 2,
    handshake: 15_000,
    analyze: 3,
    stopGrace: 2_000,
  });
});

test("Stockfish rejects invalid timeout containers", () => {
  assert.doesNotThrow(
    () =>
      new Stockfish({
        timeouts: undefined,
      } as unknown as StockfishOptions),
  );
  for (const timeouts of [null, 1, "invalid", [], () => {}]) {
    assert.throws(
      () =>
        new Stockfish({
          timeouts,
        } as unknown as StockfishOptions),
      /stockfish timeouts must be an object/,
    );
  }
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

test("late cold readiness sends quit without terminating twice", async () => {
  let callback!: (error: Error | null, engine: StockfishEngine) => void;
  const commands: string[] = [];
  let terminations = 0;
  const current = {
    listener: null,
    terminate() {
      terminations++;
    },
  } as unknown as StockfishEngine;
  const stockfish = new Stockfish({
    init: (_flavor, next) => {
      callback = next;
      return current;
    },
    timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
  });

  const active = stockfish.analyze("fen", 1, 1);
  const outcome = active.catch((error: unknown) => error);
  await nextImmediate();
  const quitting = stockfish.quit();
  let ready!: () => void;
  const readiness = new Promise<void>((resolve) => {
    ready = resolve;
  });
  setTimeout(() => {
    current.sendCommand = (command) => commands.push(command);
    callback(null, current);
    ready();
  }, 5);

  await quitting;
  await readiness;
  await nextImmediate();
  assert.match(String(await outcome), /stockfish quit/);
  assert.deepEqual(commands, ["quit"]);
  assert.equal(terminations, 1);
  assert.notEqual(current.listener, null);
});

test("reentrant quit terminates stale initializer engines exactly once", async () => {
  let callback!: (error: Error | null, current: StockfishEngine) => void;
  let quitting!: Promise<void>;
  const returned = engine();
  const late = engine();
  let stockfish!: Stockfish;
  stockfish = new Stockfish({
    init: (_flavor, initCallback) => {
      callback = initCallback;
      quitting = stockfish.quit();
      return returned;
    },
    timeouts: { init: 50, handshake: 50, analyze: 50, stopGrace: 5 },
  });

  await assert.rejects(stockfish.analyze("fen", 1, 1), /stockfish quit/);
  await quitting;
  assert.equal(returned.terminations, 1);
  assert.deepEqual(returned.commands, ["quit"]);

  callback(null, returned);
  callback(null, late);
  await nextImmediate();
  assert.equal(returned.terminations, 1);
  assert.equal(late.terminations, 1);
  assert.deepEqual(late.commands, ["quit"]);
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

test("stale callbacks do not terminate the current session engine", async () => {
  let staleCallback!: (error: Error | null, current: StockfishEngine) => void;
  const first = engine();
  const current = respondingEngine(true);
  const stale = engine();
  let attempt = 0;
  const stockfish = new Stockfish({
    init: (_flavor, callback) => {
      if (attempt++ === 0) {
        staleCallback = callback;
        return first;
      }
      queueMicrotask(() => callback(null, current));
      return current;
    },
    timeouts: { init: 5, handshake: 50, analyze: 50, stopGrace: 5 },
  });

  const failed = stockfish.analyze("first", 1, 1);
  const recovered = stockfish.analyze("second", 1, 1);
  await assert.rejects(failed, /init timeout/);
  assert.equal((await recovered)[0]?.scoreCp, 42);
  assert.equal(first.terminations, 1);

  staleCallback(null, current);
  staleCallback(null, stale);
  await nextImmediate();
  assert.equal(current.terminations, 0);
  assert.equal(stale.terminations, 1);
  assert.equal((await stockfish.analyze("third", 1, 1))[0]?.scoreCp, 42);

  await stockfish.quit();
  assert.equal(current.terminations, 1);
});

test("terminated engine objects cannot enter a new init lifecycle", async () => {
  for (const reuse of ["returned", "callback"] as const) {
    const retired = engine();
    const provisional = engine();
    const fresh = respondingEngine(true);
    let attempt = 0;
    const stockfish = new Stockfish({
      init: (_flavor, callback) => {
        attempt += 1;
        if (attempt === 1) return retired;
        if (attempt === 2) {
          queueMicrotask(() => callback(null, retired));
          return reuse === "returned" ? retired : provisional;
        }
        queueMicrotask(() => callback(null, fresh));
        return fresh;
      },
      timeouts: { init: 5, handshake: 50, analyze: 50, stopGrace: 5 },
    });

    const timedOut = stockfish.analyze("first", 1, 1);
    const reused = stockfish.analyze("second", 1, 1);
    const recovered = stockfish.analyze("third", 1, 1);
    await assert.rejects(timedOut, /init timeout/);
    await assert.rejects(reused, /initializer reused a terminated engine/);
    assert.equal((await recovered)[0]?.scoreCp, 42);
    assert.equal(retired.terminations, 1);
    assert.equal(
      retired.commands.filter((command) => command === "quit").length,
      1,
    );
    assert.equal(provisional.terminations, reuse === "callback" ? 1 : 0);
    assert.equal(fresh.terminations, 0);

    await stockfish.quit();
    assert.equal(fresh.terminations, 1);
  }
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

test("callback replacement survives reentrant old-engine teardown", async () => {
  for (const reentry of ["invalidate", "adopt"] as const) {
    let callback!: (error: Error | null, current: StockfishEngine) => void;
    let replacement!: ReturnType<typeof respondingEngine>;
    let reentered = false;
    const returned = engine((_current, command) => {
      if (command !== "quit" || reentered) return;
      reentered = true;
      callback(null, reentry === "invalidate" ? returned : replacement);
    });
    replacement = respondingEngine(true);
    const stockfish = new Stockfish({
      init: (_flavor, initCallback) => {
        callback = initCallback;
        return returned;
      },
      timeouts: { init: 50, handshake: 50, analyze: 50, stopGrace: 5 },
    });

    const analysis = stockfish.analyze("fen", 1, 1);
    await nextImmediate();
    callback(null, replacement);

    assert.equal((await analysis)[0]?.scoreCp, 42);
    assert.equal(replacement.terminations, 0);
    await stockfish.quit();
    assert.equal(replacement.terminations, 1);
    assert.equal(returned.terminations, 1);
    assert.equal(
      returned.commands.filter((command) => command === "quit").length,
      1,
    );
  }
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
  await assert.rejects(
    stockfish.analyze("second", 1, 1),
    (error: unknown) =>
      error instanceof ChessError &&
      error.code === "SERVER_BUSY" &&
      error.message === "stockfish queue full",
  );
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
  await assert.rejects(
    stockfish.analyze("overflow", 1, 1),
    (error: unknown) =>
      error instanceof ChessError &&
      error.code === "SERVER_BUSY" &&
      error.message === "stockfish queue full",
  );
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

test("quit publishes its promise before synchronous engine reentry", async () => {
  let analysisStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    analysisStarted = resolve;
  });
  let innerQuit!: Promise<void>;
  let reentered!: Promise<unknown>;
  let stopped = false;
  let stockfish!: Stockfish;
  const current = engine((current, command) => {
    if (command === "uci") {
      queueMicrotask(() => current.listener?.("uciok"));
    } else if (command === "isready") {
      queueMicrotask(() => current.listener?.("readyok"));
    } else if (command.startsWith("go depth ")) {
      analysisStarted();
    } else if (command === "stop" && !stopped) {
      stopped = true;
      innerQuit = stockfish.quit();
      reentered = stockfish
        .analyze("reentered", 1, 1)
        .then(() => null, (error: unknown) => error);
      queueMicrotask(() => current.listener?.("bestmove e2e4"));
    }
  });
  stockfish = new Stockfish({
    init: initializer([current]),
    timeouts: { init: 50, handshake: 50, analyze: 100, stopGrace: 10 },
  });

  const active = stockfish.analyze("active", 1, 1);
  const activeOutcome = active.then(() => null, (error: unknown) => error);
  await started;
  const outerQuit = stockfish.quit();

  assert.equal(innerQuit, outerQuit);
  await outerQuit;
  assert.match(String(await activeOutcome), /stockfish quit/);
  assert.match(String(await reentered), /stockfish shutting down/);
  assert.equal(current.commands.includes("position fen reentered"), false);
});

test("late repeated init callbacks cannot steal listener cleanup ownership", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const uncaught = () => {};
    const unhandled = () => {};
    const engine = (respond) => ({
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (respond && command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    });
    const returned = engine(false);
    const initialized = engine(true);
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          queueMicrotask(() => {
            callback(null, initialized);
            setTimeout(() => callback(null, returned), 20);
          });
          return returned;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      await stockfish.quit();
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(JSON.stringify({
        uncaught: process.listeners("uncaughtException").includes(uncaught),
        unhandled: process.listeners("unhandledRejection").includes(unhandled),
      }));
    } finally {
      Module._load = load;
      process.removeListener("uncaughtException", uncaught);
      process.removeListener("unhandledRejection", unhandled);
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), { uncaught: false, unhandled: false });
});

test("owned listener wrappers preserve later duplicate user registrations", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const uncaughtOrder = [];
    const unhandledOrder = [];
    const beforeUncaught = () => uncaughtOrder.push("before");
    const beforeUnhandled = () => unhandledOrder.push("before");
    const uncaught = function(error, origin) {
      uncaughtOrder.push(
        this === process && error.message === "probe" && origin === "uncaughtException"
          ? "owned"
          : "invalid",
      );
    };
    const reason = {};
    const promise = Promise.resolve();
    const unhandled = function(currentReason, currentPromise) {
      unhandledOrder.push(
        this === process && currentReason === reason && currentPromise === promise
          ? "owned"
          : "invalid",
      );
    };
    process.on("uncaughtException", beforeUncaught);
    process.on("unhandledRejection", beforeUnhandled);
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", uncaught);
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          process.on("unhandledRejection", unhandled);
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      const ownedUncaught = process
        .listeners("uncaughtException")
        .filter((listener) => listener !== beforeUncaught);
      const ownedUnhandled = process
        .listeners("unhandledRejection")
        .filter((listener) => listener !== beforeUnhandled);
      process.emit("uncaughtException", new Error("probe"), "uncaughtException");
      process.emit("unhandledRejection", reason, promise);
      for (const listener of ownedUncaught) {
        process.once("uncaughtException", listener);
      }
      for (const listener of ownedUnhandled) {
        process.once("unhandledRejection", listener);
      }
      await stockfish.quit();
      const rawUncaught = process.rawListeners("uncaughtException");
      const rawUnhandled = process.rawListeners("unhandledRejection");
      const keptOnceUncaught = ownedUncaught.every((owned) =>
        rawUncaught.some((listener) => listener.listener === owned),
      );
      const keptOnceUnhandled = ownedUnhandled.every((owned) =>
        rawUnhandled.some((listener) => listener.listener === owned),
      );
      process.emit("uncaughtException", new Error("probe"), "uncaughtException");
      process.emit("unhandledRejection", reason, promise);
      process.stdout.write(JSON.stringify({
        uncaughtOrder,
        unhandledOrder,
        uncaughtCount: rawUncaught.length,
        unhandledCount: rawUnhandled.length,
        keptBeforeUncaught: rawUncaught.includes(beforeUncaught),
        keptBeforeUnhandled: rawUnhandled.includes(beforeUnhandled),
        keptOnceUncaught,
        keptOnceUnhandled,
        onceUncaughtRemoved: process.listenerCount("uncaughtException") === 1,
        onceUnhandledRemoved: process.listenerCount("unhandledRejection") === 1,
        leakedUncaught: ownedUncaught.some((owned) => rawUncaught.includes(owned)),
        leakedUnhandled: ownedUnhandled.some((owned) => rawUnhandled.includes(owned)),
      }));
    } finally {
      Module._load = load;
      process.removeListener("uncaughtException", beforeUncaught);
      process.removeListener("unhandledRejection", beforeUnhandled);
      process.removeListener("uncaughtException", uncaught);
      process.removeListener("unhandledRejection", unhandled);
      for (const listener of process.listeners("uncaughtException")) {
        if (listener !== beforeUncaught) {
          process.removeListener("uncaughtException", listener);
        }
      }
      for (const listener of process.listeners("unhandledRejection")) {
        if (listener !== beforeUnhandled) {
          process.removeListener("unhandledRejection", listener);
        }
      }
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    uncaughtOrder: ["before", "owned", "owned", "before", "owned", "owned"],
    unhandledOrder: ["before", "owned", "owned", "before", "owned", "owned"],
    uncaughtCount: 3,
    unhandledCount: 3,
    keptBeforeUncaught: true,
    keptBeforeUnhandled: true,
    keptOnceUncaught: true,
    keptOnceUnhandled: true,
    onceUncaughtRemoved: true,
    onceUnhandledRemoved: true,
    leakedUncaught: false,
    leakedUnhandled: false,
  });
});

test("owned listener tokens survive public wrapper removal and prepending", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const uncaughtOrder = [];
    const unhandledOrder = [];
    const markerUncaught = () => uncaughtOrder.push("marker");
    const markerUnhandled = () => unhandledOrder.push("marker");
    const originalUncaught = () => uncaughtOrder.push("hook");
    const originalUnhandled = () => unhandledOrder.push("hook");
    process.on("uncaughtException", markerUncaught);
    process.on("unhandledRejection", markerUnhandled);
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", originalUncaught);
          process.on("uncaughtException", originalUncaught);
          process.on("unhandledRejection", originalUnhandled);
          process.on("unhandledRejection", originalUnhandled);
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      const uncaught = process
        .listeners("uncaughtException")
        .filter((listener) => listener !== markerUncaught);
      const unhandled = process
        .listeners("unhandledRejection")
        .filter((listener) => listener !== markerUnhandled);
      const registeredUncaught = process
        .rawListeners("uncaughtException")
        .filter((listener) => listener !== markerUncaught);
      const registeredUnhandled = process
        .rawListeners("unhandledRejection")
        .filter((listener) => listener !== markerUnhandled);

      process.removeListener("uncaughtException", uncaught[0]);
      process.on("uncaughtException", uncaught[0]);
      process.prependListener("uncaughtException", uncaught[1]);
      process.removeListener("unhandledRejection", unhandled[0]);
      process.on("unhandledRejection", unhandled[0]);
      process.prependListener("unhandledRejection", unhandled[1]);
      await stockfish.quit();

      const remainingUncaught = process.listeners("uncaughtException");
      const remainingUnhandled = process.listeners("unhandledRejection");
      process.emit("uncaughtException", new Error("probe"), "uncaughtException");
      process.emit("unhandledRejection", {}, Promise.resolve());
      process.stdout.write(JSON.stringify({
        uncaughtSequence: remainingUncaught.map((listener) =>
          listener === markerUncaught ? "marker" : "shared",
        ),
        unhandledSequence: remainingUnhandled.map((listener) =>
          listener === markerUnhandled ? "marker" : "shared",
        ),
        uncaughtOrder,
        unhandledOrder,
        ownedUncaughtLeft: registeredUncaught.some((listener) =>
          process.rawListeners("uncaughtException").includes(listener),
        ),
        ownedUnhandledLeft: registeredUnhandled.some((listener) =>
          process.rawListeners("unhandledRejection").includes(listener),
        ),
      }));
    } finally {
      Module._load = load;
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    uncaughtSequence: ["shared", "marker", "shared"],
    unhandledSequence: ["shared", "marker", "shared"],
    uncaughtOrder: ["hook", "marker", "hook"],
    unhandledOrder: ["hook", "marker", "hook"],
    ownedUncaughtLeft: false,
    ownedUnhandledLeft: false,
  });
});

test("throwing process removal observers cannot strand engine teardown", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const removeListener = process.removeListener;
    const swallow = () => {};
    const uncaught = () => {};
    const unhandled = () => {};
    process.prependListener("uncaughtException", swallow);
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", uncaught);
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          process.on("unhandledRejection", unhandled);
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    let active = true;
    let observerThrows = 0;
    let preRemovalThrows = 0;
    const observer = (event) => {
      if (
        active &&
        (event === "uncaughtException" || event === "unhandledRejection")
      ) {
        observerThrows++;
        throw new Error("removal observer failed");
      }
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      process.on("removeListener", observer);
      process.removeListener = function(event, listener) {
        if (
          active &&
          event === "uncaughtException" &&
          preRemovalThrows++ === 0
        ) {
          throw new Error("pre-removal failure");
        }
        return removeListener.call(this, event, listener);
      };
      const result = await Promise.race([
        stockfish.quit().then(() => "resolved", () => "rejected"),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 100)),
      ]);
      active = false;
      process.stdout.write(JSON.stringify({
        result,
        observerThrows,
        preRemovalThrows,
        teardownPending: stockfish.teardownPending,
        uncaught: process.listenerCount("uncaughtException"),
        unhandled: process.listenerCount("unhandledRejection"),
      }));
    } finally {
      active = false;
      Module._load = load;
      process.removeListener = removeListener;
      process.removeListener("removeListener", observer);
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    result: "resolved",
    observerThrows: 4,
    preRemovalThrows: 0,
    teardownPending: 0,
    uncaught: 1,
    unhandled: 0,
  });
});

test("init failure preserves its error while cleaning throwing process hooks", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const methodNames = ["on", "addListener", "prependListener", "once", "prependOnceListener"];
    const methods = methodNames.map((name) => process[name]);
    const methodOwn = methodNames.map((name) => Object.hasOwn(process, name));
    const swallow = () => {};
    const uncaught = () => {};
    const unhandled = () => {};
    process.prependListener("uncaughtException", swallow);
    let active = true;
    let observerThrows = 0;
    const observer = (event) => {
      if (
        active &&
        (event === "uncaughtException" || event === "unhandledRejection")
      ) {
        observerThrows++;
        throw new Error("observer failed");
      }
    };
    process.on("removeListener", observer);
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return () => {
          process.on("uncaughtException", uncaught);
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          process.on("unhandledRejection", unhandled);
          throw new Error("init failed");
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const outcome = await stockfish
        .analyze("fen", 1, 1)
        .then(() => "resolved", (error) => String(error));
      active = false;
      process.stdout.write(JSON.stringify({
        outcome,
        observerThrows,
        methodsRestored: methodNames.every(
          (name, index) =>
            process[name] === methods[index] && Object.hasOwn(process, name) === methodOwn[index],
        ),
        uncaught: process.listeners("uncaughtException").includes(uncaught),
        unhandled: process.listeners("unhandledRejection").includes(unhandled),
      }));
    } finally {
      active = false;
      Module._load = load;
      process.removeListener("removeListener", observer);
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    outcome: "Error: init failed",
    observerThrows: 4,
    methodsRestored: true,
    uncaught: false,
    unhandled: false,
  });
});

test("listener ownership failure disposes its orphan engine transactionally", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const swallow = () => {};
    const uncaught = () => {};
    const unhandled = () => {};
    const engine = (name, respond) => ({
      listener: null,
      commands: [],
      terminations: 0,
      sendCommand(command) {
        this.commands.push(command);
        if (respond && command === "uci") {
          queueMicrotask(() => this.listener?.("uciok"));
        } else if (respond && command === "isready") {
          queueMicrotask(() => this.listener?.("readyok"));
        } else if (respond && command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {
        this.terminations++;
      },
      name,
    });
    const returned = engine("returned", false);
    const initialized = engine("initialized", true);
    process.prependListener("uncaughtException", swallow);
    let active = true;
    let observerThrows = 0;
    const observer = (event) => {
      if (
        active &&
        (event === "uncaughtException" || event === "unhandledRejection")
      ) {
        observerThrows++;
        throw new Error("observer failed");
      }
    };
    process.on("removeListener", observer);
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", uncaught);
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          process.on("unhandledRejection", unhandled);
          callback(null, initialized);
          return returned;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const outcome = await stockfish
        .analyze("fen", 1, 1)
        .then(() => "resolved", (error) => String(error));
      await stockfish.quit();
      active = false;
      process.stdout.write(JSON.stringify({
        outcome,
        observerThrows,
        engines: [returned, initialized].map((current) => ({
          name: current.name,
          quitCommands: current.commands.filter((command) => command === "quit").length,
          terminations: current.terminations,
        })),
        uncaught: process.listeners("uncaughtException").includes(uncaught),
        unhandled: process.listeners("unhandledRejection").includes(unhandled),
      }));
    } finally {
      active = false;
      Module._load = load;
      process.removeListener("removeListener", observer);
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    outcome: "resolved",
    observerThrows: 4,
    engines: [
      { name: "returned", quitCommands: 1, terminations: 1 },
      { name: "initialized", quitCommands: 1, terminations: 1 },
    ],
    uncaught: false,
    unhandled: false,
  });
});

test("failed acquisition disposes repeated late callback engines once", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const initError = new Error("init failed");
    const engine = (name) => ({
      listener: null,
      commands: [],
      terminations: 0,
      sendCommand(command) {
        this.commands.push(command);
      },
      terminate() {
        this.terminations++;
      },
      name,
    });
    const first = engine("first");
    const second = engine("second");
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          setTimeout(() => {
            callback(null, first);
            callback(null, first);
            callback(null, second);
          }, 0);
          throw initError;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const originalError = await stockfish
        .analyze("fen", 1, 1)
        .then(() => false, (error) => error === initError);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await stockfish.quit();
      process.stdout.write(JSON.stringify({
        originalError,
        engines: [first, second].map((current) => ({
          name: current.name,
          commands: current.commands,
          terminations: current.terminations,
        })),
      }));
    } finally {
      Module._load = load;
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    originalError: true,
    engines: [
      { name: "first", commands: ["quit"], terminations: 1 },
      { name: "second", commands: ["quit"], terminations: 1 },
    ],
  });
});

test("prepended duplicate hooks preserve preexisting once occurrences", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    let hooks = 0;
    let markers = 0;
    const shared = () => hooks++;
    const marker = () => markers++;
    process.on("uncaughtException", marker);
    process.once("uncaughtException", shared);
    let blocked = 0;
    const blocker = (_event, listener) => {
      if (listener === marker) {
        blocked++;
        throw new Error("blocked marker restore");
      }
    };
    process.on("newListener", blocker);
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.prependListener("uncaughtException", shared);
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      await stockfish.quit();
      const order = process.rawListeners("uncaughtException").map((listener) =>
        listener === marker
          ? "marker"
          : listener.listener === shared
            ? "once-shared"
            : listener === shared
              ? "persistent-shared"
              : "other",
      );
      process.emit("uncaughtException", new Error("first"), "uncaughtException");
      process.emit("uncaughtException", new Error("second"), "uncaughtException");
      process.stdout.write(JSON.stringify({ blocked, hooks, markers, order }));
    } finally {
      Module._load = load;
      process.removeListener("newListener", blocker);
      process.removeAllListeners("uncaughtException");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    blocked: 0,
    hooks: 1,
    markers: 2,
    order: ["marker", "once-shared"],
  });
});

test("failed prepended acquisition restores the exact raw listener baseline", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const initError = new Error("init failed");
    let hooks = 0;
    let markers = 0;
    const shared = () => hooks++;
    const marker = () => markers++;
    process.on("uncaughtException", marker);
    process.once("uncaughtException", shared);
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return () => {
          process.prependListener("uncaughtException", shared);
          throw initError;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const originalError = await stockfish
        .analyze("fen", 1, 1)
        .then(() => false, (error) => error === initError);
      const order = process.rawListeners("uncaughtException").map((listener) =>
        listener === marker
          ? "marker"
          : listener.listener === shared
            ? "once-shared"
            : listener === shared
              ? "persistent-shared"
              : "other",
      );
      process.emit("uncaughtException", new Error("first"), "uncaughtException");
      process.emit("uncaughtException", new Error("second"), "uncaughtException");
      process.stdout.write(JSON.stringify({ originalError, hooks, markers, order }));
    } finally {
      Module._load = load;
      process.removeAllListeners("uncaughtException");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    originalError: true,
    hooks: 1,
    markers: 2,
    order: ["marker", "once-shared"],
  });
});

test("ordinary listener acquisition does not re-register preexisting hooks", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const methodNames = ["on", "addListener", "prependListener", "once", "prependOnceListener"];
    const methods = methodNames.map((name) => process[name]);
    const methodOwn = methodNames.map((name) => Object.hasOwn(process, name));
    const markerUncaught = () => {};
    const markerUnhandled = () => {};
    const uncaught = () => {};
    const unhandled = () => {};
    process.on("uncaughtException", markerUncaught);
    process.on("unhandledRejection", markerUnhandled);
    let markerAdds = 0;
    let markerRemovals = 0;
    process.on("newListener", (_event, listener) => {
      if (listener === markerUncaught || listener === markerUnhandled) markerAdds++;
    });
    process.on("removeListener", (_event, listener) => {
      if (listener === markerUncaught || listener === markerUnhandled) {
        markerRemovals++;
      }
    });
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", uncaught);
          process.on("unhandledRejection", unhandled);
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      await stockfish.quit();
      process.stdout.write(JSON.stringify({
        markerAdds,
        markerRemovals,
        methodsRestored: methodNames.every(
          (name, index) =>
            process[name] === methods[index] && Object.hasOwn(process, name) === methodOwn[index],
        ),
      }));
    } finally {
      Module._load = load;
      process.removeAllListeners("newListener");
      process.removeAllListeners("removeListener");
      process.removeAllListeners("uncaughtException");
      process.removeAllListeners("unhandledRejection");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    markerAdds: 0,
    markerRemovals: 0,
    methodsRestored: true,
  });
});

test("captured process methods preserve once and borrowed receiver semantics", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import { EventEmitter } from "node:events";
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const order = [];
    let borrowed = 0;
    let invalid = false;
    process.on("uncaughtException", () => order.push("marker"));
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", () => order.push("on"));
          process.addListener("uncaughtException", () => order.push("add"));
          process.prependListener("uncaughtException", () => order.push("prepend"));
          process.once("uncaughtException", () => order.push("once"));
          process.prependOnceListener("uncaughtException", () => order.push("prependOnce"));
          const emitter = new EventEmitter();
          process.on.call(emitter, "uncaughtException", () => borrowed++);
          emitter.emit("uncaughtException", new Error("borrowed"));
          try {
            process.on("uncaughtException", null);
          } catch (error) {
            invalid = error instanceof TypeError;
          }
          queueMicrotask(() => callback(null, engine));
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      await stockfish.analyze("fen", 1, 1);
      process.emit("uncaughtException", new Error("first"), "uncaughtException");
      process.emit("uncaughtException", new Error("second"), "uncaughtException");
      await stockfish.quit();
      process.stdout.write(JSON.stringify({ borrowed, invalid, order }));
    } finally {
      Module._load = load;
      process.removeAllListeners("uncaughtException");
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    borrowed: 1,
    invalid: true,
    order: [
      "prependOnce",
      "prepend",
      "marker",
      "on",
      "add",
      "once",
      "prepend",
      "marker",
      "on",
      "add",
    ],
  });
});

test("async initializer hooks stay owned without capturing unrelated work", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const names = ["on", "addListener", "prependListener", "once", "prependOnceListener"];
    const methods = names.map((name) => process[name]);
    const own = names.map((name) => Object.hasOwn(process, name));
    let packageHits = 0;
    let appHits = 0;
    let aliasDuring = false;
    const packageHook = () => packageHits++;
    const appHook = () => appHits++;
    const engine = {
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return (_flavor, callback) => {
          aliasDuring = process.on === process.addListener;
          setTimeout(() => {
            process.on("uncaughtException", packageHook);
            callback(null, engine);
          }, 20);
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const analysis = stockfish.analyze("fen", 1, 1);
      setTimeout(() => process.on("uncaughtException", appHook), 5);
      await analysis;
      await stockfish.quit();
      process.emit("uncaughtException", new Error("probe"), "uncaughtException");
      process.stdout.write(JSON.stringify({
        aliasDuring,
        appHits,
        packageHits,
        packageHook: process.listeners("uncaughtException").includes(packageHook),
        appHook: process.listeners("uncaughtException").includes(appHook),
        restored: names.every(
          (name, index) => process[name] === methods[index] && Object.hasOwn(process, name) === own[index],
        ),
      }));
    } finally {
      Module._load = load;
      process.removeListener("uncaughtException", packageHook);
      process.removeListener("uncaughtException", appHook);
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    aliasDuring: true,
    appHits: 1,
    packageHits: 0,
    packageHook: false,
    appHook: true,
    restored: true,
  });
});

test("nested hook captures retain independent cleanup ownership", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    let calls = 0;
    let outerHits = 0;
    let innerHits = 0;
    let innerReady;
    const outerHook = () => outerHits++;
    const innerHook = () => innerHits++;
    const engine = () => ({
      listener: null,
      sendCommand(command) {
        if (command === "uci") queueMicrotask(() => this.listener?.("uciok"));
        else if (command === "isready") queueMicrotask(() => this.listener?.("readyok"));
        else if (command.startsWith("go depth ")) {
          queueMicrotask(() => this.listener?.("bestmove e2e4"));
        }
      },
      terminate() {},
    });
    const outerEngine = engine();
    const innerEngine = engine();
    const inner = new Stockfish({
      timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
    });
    const outer = new Stockfish({
      timeouts: { init: 100, handshake: 100, analyze: 100, stopGrace: 5 },
    });
    Module._load = function(request, parent, isMain) {
      if (request === entry && ++calls === 1) {
        return (_flavor, callback) => {
          process.on("uncaughtException", outerHook);
          innerReady = inner.init();
          queueMicrotask(() => callback(null, outerEngine));
          return outerEngine;
        };
      }
      if (request === entry) {
        return (_flavor, callback) => {
          process.on("uncaughtException", innerHook);
          queueMicrotask(() => callback(null, innerEngine));
          return innerEngine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      await outer.analyze("fen", 1, 1);
      await innerReady;
      await inner.quit();
      process.emit("uncaughtException", new Error("inner closed"), "uncaughtException");
      const afterInner = { outerHits, innerHits };
      await outer.quit();
      process.emit("uncaughtException", new Error("outer closed"), "uncaughtException");
      process.stdout.write(JSON.stringify({ afterInner, afterOuter: { outerHits, innerHits } }));
    } finally {
      Module._load = load;
      process.removeListener("uncaughtException", outerHook);
      process.removeListener("uncaughtException", innerHook);
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    afterInner: { outerHits: 1, innerHits: 0 },
    afterOuter: { outerHits: 1, innerHits: 0 },
  });
});

test("callback timeout releases hook capture and restores process methods", async () => {
  const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
  const source = `
    import Module, { createRequire } from "node:module";
    import { Stockfish } from ${JSON.stringify(moduleUrl)};
    const require = createRequire(import.meta.url);
    const entry = require.resolve("stockfish");
    const load = Module._load;
    const names = ["on", "addListener", "prependListener", "once", "prependOnceListener"];
    const methods = names.map((name) => process[name]);
    const own = names.map((name) => Object.hasOwn(process, name));
    const hook = () => {};
    const engine = { listener: null, sendCommand() {}, terminate() {} };
    Module._load = function(request, parent, isMain) {
      if (request === entry) {
        return () => {
          process.on("uncaughtException", hook);
          return engine;
        };
      }
      return load.call(this, request, parent, isMain);
    };
    try {
      const stockfish = new Stockfish({
        timeouts: { init: 20, handshake: 100, analyze: 100, stopGrace: 5 },
      });
      const outcome = await stockfish
        .analyze("fen", 1, 1)
        .then(() => "resolved", (error) => String(error));
      await stockfish.quit();
      process.stdout.write(JSON.stringify({
        outcome,
        hook: process.listeners("uncaughtException").includes(hook),
        restored: names.every(
          (name, index) => process[name] === methods[index] && Object.hasOwn(process, name) === own[index],
        ),
      }));
    } finally {
      Module._load = load;
      process.removeListener("uncaughtException", hook);
    }
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    { cwd: process.cwd(), encoding: "utf8", timeout: 5_000 },
  );
  assert.deepEqual(JSON.parse(stdout), {
    outcome: "Error: stockfish init timeout",
    hook: false,
    restored: true,
  });
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
  "real Stockfish restarts release only their process listeners",
  { timeout: 20_000 },
  async () => {
    const moduleUrl = new URL("../src/engines/stockfish.ts", import.meta.url).href;
    const source = `
      import { Stockfish } from ${JSON.stringify(moduleUrl)};
      const fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
      const warnings = [];
      const beforeUncaught = () => {};
      const beforeUnhandled = () => {};
      const afterUncaught = () => {};
      const afterUnhandled = () => {};
      process.on("warning", (warning) => warnings.push(warning.name));
      process.on("uncaughtException", beforeUncaught);
      process.on("unhandledRejection", beforeUnhandled);

      for (let index = 0; index < 12; index++) {
        const stockfish = new Stockfish({
          flavor: "lite-single",
          timeouts: { init: 5000, handshake: 5000, analyze: 5000, stopGrace: 500 },
        });
        await stockfish.analyze(fen, 1, 1);
        if (index === 0) {
          process.on("uncaughtException", afterUncaught);
          process.on("unhandledRejection", afterUnhandled);
          const engine = stockfish.session.engine;
          const terminate = engine.terminate.bind(engine);
          engine.terminate = () => {
            terminate();
            throw new Error("termination wrapper failed");
          };
        }
        await stockfish.quit();
      }
      await new Promise((resolve) => setImmediate(resolve));
      process.stdout.write(JSON.stringify({
        uncaught: process.listenerCount("uncaughtException"),
        unhandled: process.listenerCount("unhandledRejection"),
        keptUncaught:
          process.listeners("uncaughtException").includes(beforeUncaught) &&
          process.listeners("uncaughtException").includes(afterUncaught),
        keptUnhandled:
          process.listeners("unhandledRejection").includes(beforeUnhandled) &&
          process.listeners("unhandledRejection").includes(afterUnhandled),
        warnings,
      }));
    `;
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      { cwd: process.cwd(), encoding: "utf8", timeout: 15_000 },
    );
    const result = JSON.parse(stdout) as {
      uncaught: number;
      unhandled: number;
      keptUncaught: boolean;
      keptUnhandled: boolean;
      warnings: string[];
    };
    assert.deepEqual(result, {
      uncaught: 2,
      unhandled: 2,
      keptUncaught: true,
      keptUnhandled: true,
      warnings: [],
    });
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
