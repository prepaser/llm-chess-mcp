import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  candidateSetFromData,
  computeMoveSensitivity,
  createCandidateComputation,
  explorerCandidateData,
  rankByIntent,
  type LichessCandidateData,
} from "../src/intents.js";
import type { Candidate, SfLine } from "../src/types.js";

function sfLine(
  uci: string,
  scoreCp: number | null,
  multipv = 1,
  wdl: [number, number, number] | null = null,
  scoreMate: number | null = null,
): SfLine {
  return { multipv, scoreCp, scoreMate, wdl, pv: [uci] };
}

function candidate(
  uci: string,
  moverCp: number | null,
  maia3Prob: number | null,
  winMargin: number | null = null,
): Candidate {
  return {
    uci,
    san: uci,
    objective: {
      rank: moverCp === null ? null : 1,
      moverCp,
      whiteCp: moverCp,
      cpLoss: null,
      moverMate: null,
      whiteMate: null,
      wdl: winMargin === null ? null : [winMargin, 0, 0],
    },
    human: { maia3Prob, selfElo: 1500, opponentElo: 1500 },
    opening: {
      status: "disabled",
      games: null,
      frequency: null,
      white: null,
      draws: null,
      black: null,
      averageRating: null,
    },
  };
}

test("opening frequency uses all games, not only returned moves", () => {
  const result = explorerCandidateData({
    db: "lichess",
    white: 50,
    draws: 30,
    black: 20,
    moves: [
      {
        uci: "e2e4",
        san: "e4",
        white: 10,
        draws: 5,
        black: 5,
        count: 20,
        averageRating: 1800,
      },
    ],
    opening: null,
  });

  assert.equal(result.totalGames, 100);
  const move = result.moves[0];
  assert.ok(move);
  assert.equal(move.count / result.totalGames, 0.2);
});

test("marks an empty explorer result as no data", () => {
  assert.deepEqual(
    explorerCandidateData({
      db: "masters",
      white: 0,
      draws: 0,
      black: 0,
      moves: [],
      opening: null,
    }),
    { status: "no_data", totalGames: 0, moves: [] },
  );
});

test("rejects explorer moves that exceed aggregate result counts", () => {
  assert.throws(
    () =>
      explorerCandidateData({
        db: "lichess",
        white: 1,
        draws: 0,
        black: 0,
        moves: [
          {
            uci: "e2e4",
            san: "e4",
            white: 1,
            draws: 0,
            black: 0,
            count: 1,
            averageRating: null,
          },
          {
            uci: "d2d4",
            san: "d4",
            white: 1,
            draws: 0,
            black: 0,
            count: 1,
            averageRating: null,
          },
        ],
        opening: null,
      }),
    /move totals exceed explorer totals/,
  );
});

test("rethrows caller cancellation from the Lichess fallback", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled");
  const computeCandidates = createCandidateComputation({
    analyze: async () => [],
    humanMoveDistribution: async () => [],
    explorerEnabled: () => true,
    openingExplorer: async (_chess, _db, _speeds, _ratings, signal) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
      }),
    explorerFailureReason: () => "upstream",
  });

  const pending = computeCandidates(
    new Chess(),
    1500,
    1,
    1,
    1,
    { db: "lichess", speeds: [], ratings: [] },
    controller.signal,
  );
  controller.abort(cause);

  await assert.rejects(pending, (error: unknown) => error === cause);
});

test("rechecks caller cancellation after candidate sources finish", async () => {
  const controller = new AbortController();
  const cause = new Error("caller cancelled after fulfillment");
  const computeCandidates = createCandidateComputation({
    analyze: async () => {
      queueMicrotask(() => controller.abort(cause));
      return [];
    },
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => {
      throw new Error("unreachable");
    },
    explorerFailureReason: () => "upstream",
  });

  await assert.rejects(
    computeCandidates(new Chess(), 1500, 1, 1, 1, null, controller.signal),
    (error: unknown) => error === cause,
  );
});

test("aborts sibling candidate sources after a fatal source failure", async () => {
  const failure = new Error("Maia failed");
  let engineAbort: unknown;
  let explorerCalls = 0;
  let resolveEngineStopped!: () => void;
  const engineStopped = new Promise<void>((resolve) => {
    resolveEngineStopped = resolve;
  });
  const computeCandidates = createCandidateComputation({
    analyze: async (_fen, _depth, _multipv, signal) =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            engineAbort = signal.reason;
            resolveEngineStopped();
            reject(signal.reason);
          },
          { once: true },
        );
      }),
    humanMoveDistribution: () => {
      throw failure;
    },
    explorerEnabled: () => true,
    openingExplorer: async (_chess, _db, _speeds, _ratings, signal) => {
      explorerCalls += 1;
      signal?.throwIfAborted();
      throw new Error("unreachable");
    },
    explorerFailureReason: () => "upstream",
  });

  await assert.rejects(
    computeCandidates(
      new Chess(),
      1500,
      1,
      1,
      1,
      { db: "lichess", speeds: [], ratings: [] },
    ),
    (error: unknown) => error === failure,
  );
  await engineStopped;
  assert.equal(engineAbort, failure);
  assert.equal(explorerCalls, 0);
});

test("aborts candidate sources after fatal Explorer dependency failures", async () => {
  for (const stage of ["enabled", "reason"] as const) {
    const failure = new Error(`Explorer ${stage} failed`);
    const aborts: unknown[] = [];
    let resolveStopped!: () => void;
    let stopped = 0;
    const allStopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const waitForAbort = async (signal?: AbortSignal): Promise<never> =>
      await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            aborts.push(signal.reason);
            stopped += 1;
            if (stopped === 2) resolveStopped();
            reject(signal.reason);
          },
          { once: true },
        );
      });
    const computeCandidates = createCandidateComputation({
      analyze: async (_fen, _depth, _multipv, signal) =>
        await waitForAbort(signal),
      humanMoveDistribution: async (_chess, _elo, _opponent, _topN, signal) =>
        await waitForAbort(signal),
      explorerEnabled: () => {
        if (stage === "enabled") throw failure;
        return true;
      },
      openingExplorer: async () => {
        throw new Error("optional failure");
      },
      explorerFailureReason: () => {
        throw failure;
      },
    });

    await assert.rejects(
      computeCandidates(
        new Chess(),
        1500,
        1,
        1,
        1,
        { db: "lichess", speeds: [], ratings: [] },
      ),
      (error: unknown) => error === failure,
    );
    await allStopped;
    assert.deepEqual(aborts, [failure, failure]);
  }
});

test("rejects unsafe derived candidate counts and evaluation spreads", () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () =>
      explorerCandidateData({
        db: "lichess",
        white: max,
        draws: max,
        black: max,
        moves: [],
        opening: null,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      computeMoveSensitivity([
        sfLine("e2e4", max),
        sfLine("d2d4", -max),
      ]),
    RangeError,
  );
});

test("terminal positions skip candidate sources and discard supplied candidates", async () => {
  let analyzeCalls = 0;
  let humanCalls = 0;
  let explorerCalls = 0;
  const terminal = new Chess("8/8/8/8/8/8/K7/7k w - - 0 1");
  const computeCandidates = createCandidateComputation({
    analyze: async () => {
      analyzeCalls += 1;
      return [sfLine("a2a3", 10)];
    },
    humanMoveDistribution: async () => {
      humanCalls += 1;
      return [{ uci: "a2a3", san: "Ka3", prob: 1 }];
    },
    explorerEnabled: () => true,
    openingExplorer: async () => {
      explorerCalls += 1;
      return {
        db: "lichess",
        white: 1,
        draws: 0,
        black: 0,
        moves: [],
        opening: null,
      };
    },
    explorerFailureReason: () => "upstream",
  });

  assert.deepEqual(
    await computeCandidates(
      terminal,
      1500,
      1,
      1,
      1,
      { db: "lichess", speeds: [], ratings: [] },
    ),
    { candidates: [], moveSensitivity: { level: "low", topMoveSpreadCp: null } },
  );
  assert.deepEqual([analyzeCalls, humanCalls, explorerCalls], [0, 0, 0]);

  assert.deepEqual(
    candidateSetFromData(
      terminal,
      1500,
      [sfLine("a2a3", 10)],
      [{ uci: "a2a3", san: "Ka3", prob: 1 }],
      { status: "disabled", totalGames: null, moves: [] },
    ),
    { candidates: [], moveSensitivity: { level: "low", topMoveSpreadCp: null } },
  );
});

test("merges engine, Maia, and opening data without dropping unique moves", () => {
  const { candidates, moveSensitivity } = candidateSetFromData(
    new Chess(),
    1800,
    [sfLine("e2e4", 80, 1), sfLine("d2d4", 20, 2)],
    [
      { uci: "d2d4", san: "d4", prob: 0.4 },
      { uci: "g1f3", san: "Nf3", prob: 0.3 },
    ],
    {
      status: "available",
      totalGames: 100,
      moves: [
        {
          uci: "c2c4",
          san: "c4",
          white: 6,
          draws: 3,
          black: 1,
          count: 10,
          averageRating: 1900,
        },
      ],
    },
  );

  assert.deepEqual(candidates.map(({ uci }) => uci), [
    "e2e4",
    "d2d4",
    "g1f3",
    "c2c4",
  ]);
  assert.deepEqual(candidates[0], {
    uci: "e2e4",
    san: "e4",
    objective: {
      rank: 1,
      moverCp: 80,
      whiteCp: 80,
      cpLoss: 0,
      moverMate: null,
      whiteMate: null,
      wdl: null,
    },
    human: { maia3Prob: null, selfElo: 1800, opponentElo: 1800 },
    opening: {
      status: "available",
      games: null,
      frequency: null,
      white: null,
      draws: null,
      black: null,
      averageRating: null,
    },
  });
  assert.equal(candidates[1]?.objective.cpLoss, 60);
  assert.equal(candidates[1]?.human.maia3Prob, 0.4);
  assert.deepEqual(candidates[3]?.opening, {
    status: "available",
    games: 10,
    frequency: 0.1,
    white: 6,
    draws: 3,
    black: 1,
    averageRating: 1900,
  });
  assert.deepEqual(moveSensitivity, { level: "low", topMoveSpreadCp: 60 });
});

test("converts black-to-move evaluations to White POV and preserves mate", () => {
  const chess = new Chess();
  chess.move("e4");
  const { candidates } = candidateSetFromData(
    chess,
    1200,
    [sfLine("e7e5", null, 1, [800, 150, 50], 3)],
    [],
    { status: "disabled", totalGames: null, moves: [] },
  );

  assert.deepEqual(candidates[0]?.objective, {
    rank: 1,
    moverCp: 9700,
    whiteCp: -9700,
    cpLoss: 0,
    moverMate: 3,
    whiteMate: -3,
    wdl: [800, 150, 50],
  });
});

test("uses only legal scored root lines for engine candidate metrics", () => {
  const { candidates, moveSensitivity } = candidateSetFromData(
    new Chess(),
    1500,
    [
      sfLine("e2e4", 100, 1),
      sfLine("g1f3", 20, 2),
      sfLine("e7e5", 500, 3),
      sfLine("d2d4", null, 4),
      { multipv: 5, scoreCp: 400, scoreMate: null, wdl: null, pv: ["bad"] },
    ],
    [{ uci: "d2d4", san: "d4", prob: 0.2 }],
    { status: "disabled", totalGames: null, moves: [] },
  );

  assert.deepEqual(candidates.map(({ uci }) => uci), ["e2e4", "g1f3", "d2d4"]);
  assert.equal(candidates[0]?.objective.cpLoss, 0);
  assert.equal(candidates[1]?.objective.cpLoss, 80);
  assert.equal(candidates[2]?.objective.moverCp, null);
  assert.deepEqual(moveSensitivity, { level: "medium", topMoveSpreadCp: 80 });
});

test("filters illegal dependency moves and handles explorer failures", () => {
  const { candidates, moveSensitivity } = candidateSetFromData(
    new Chess(),
    1500,
    [
      { multipv: 1, scoreCp: 100, scoreMate: null, wdl: null, pv: [] },
      sfLine("e2e4", null),
    ],
    [{ uci: "not-uci", san: "ignored", prob: 0.2 }],
    {
      status: "unavailable",
      reason: "rate_limited",
      totalGames: null,
      moves: [],
    },
  );

  assert.deepEqual(candidates, []);
  assert.deepEqual(moveSensitivity, { level: "low", topMoveSpreadCp: null });

  assert.deepEqual(
    candidateSetFromData(new Chess(), 1500, [], [], {
      status: "available",
      totalGames: 1,
      moves: [
        {
          uci: "e2e5",
          san: "e5",
          white: 1,
          draws: 0,
          black: 0,
          count: 1,
          averageRating: null,
        },
      ],
    }).candidates,
    [],
  );
});

test("rejects malformed and duplicate candidate dependency data", () => {
  const disabled: LichessCandidateData = {
    status: "disabled",
    totalGames: null,
    moves: [],
  };
  assert.throws(
    () =>
      candidateSetFromData(
        new Chess(),
        1500,
        [],
        [{ uci: "e2e4", san: "e4", prob: 2 }],
        disabled,
      ),
    /probability/,
  );
  assert.throws(
    () =>
      candidateSetFromData(
        new Chess(),
        1500,
        [],
        [
          { uci: "e2e4", san: "e4", prob: 0.5 },
          { uci: "e2e4", san: "e4", prob: 0.4 },
        ],
        disabled,
      ),
    /duplicate Maia move/,
  );
  assert.throws(
    () =>
      candidateSetFromData(new Chess(), 1500, [], [], {
        status: "available",
        totalGames: 1,
        moves: [
          {
            uci: "e2e4",
            san: "e4",
            white: 2,
            draws: 0,
            black: 0,
            count: 2,
            averageRating: null,
          },
        ],
      }),
    /move count exceeds explorer total/,
  );
  const move = {
    uci: "e2e4",
    san: "e4",
    white: 1,
    draws: 0,
    black: 0,
    count: 1,
    averageRating: null,
  };
  assert.throws(
    () =>
      candidateSetFromData(new Chess(), 1500, [], [], {
        status: "available",
        totalGames: 2,
        moves: [move, { ...move }],
      }),
    /duplicate explorer move/,
  );
});

test("classifies move sensitivity at exact spread boundaries", () => {
  assert.deepEqual(computeMoveSensitivity([]), {
    level: "low",
    topMoveSpreadCp: null,
  });
  assert.deepEqual(
    computeMoveSensitivity([sfLine("e2e4", 100), sfLine("d2d4", 21)]),
    { level: "low", topMoveSpreadCp: 79 },
  );
  assert.deepEqual(
    computeMoveSensitivity([sfLine("e2e4", 100), sfLine("d2d4", 20)]),
    { level: "medium", topMoveSpreadCp: 80 },
  );
  assert.deepEqual(
    computeMoveSensitivity([sfLine("e2e4", 100), sfLine("d2d4", -100)]),
    { level: "high", topMoveSpreadCp: 200 },
  );
});

test("ranks objective, human, and balanced intents", () => {
  const candidates = [
    candidate("best", 200, 0),
    candidate("strong", 100, 0.1),
    candidate("natural", 0, 0.8),
    candidate("unknown", null, null),
  ];

  assert.deepEqual(
    rankByIntent(candidates, "best").map(({ uci }) => uci),
    ["best", "strong", "natural"],
  );
  assert.deepEqual(
    rankByIntent(candidates, "strong").map(({ uci }) => uci),
    ["strong", "natural"],
  );
  assert.deepEqual(
    rankByIntent(candidates, "natural").map(({ uci }) => uci),
    ["natural", "strong", "best"],
  );
  assert.deepEqual(
    rankByIntent(candidates, "balanced").map(({ uci }) => uci),
    ["natural", "best", "strong", "unknown"],
  );
});

test("keeps evaluated mate-loss candidates ahead of missing evaluations when balanced", () => {
  const candidates = [
    candidate("mate-loss", -9700, 0),
    candidate("unevaluated", null, 0.9),
  ];

  assert.deepEqual(
    rankByIntent(candidates, "balanced").map(({ uci }) => uci),
    ["mate-loss", "unevaluated"],
  );
});

test("filters and ranks constrained intents by WDL drop", () => {
  const candidates = [
    candidate("top", 200, 0.9, 200),
    candidate("ease-low", 190, 0.2, 185),
    candidate("ease-high", 180, 0.8, 150),
    candidate("chance-low", 170, 0.3, 149),
    candidate("chance-high", 160, 0.7, 50),
    candidate("too-far", 150, 0.9, 49),
    candidate("losing", 140, 0.9, -10),
    candidate("no-human", 130, null, 180),
    candidate("no-wdl", 120, 0.9),
  ];

  assert.deepEqual(
    rankByIntent(candidates, "ease_off").map(({ uci }) => uci),
    ["ease-high", "ease-low"],
  );
  assert.deepEqual(
    rankByIntent(candidates, "give_chance").map(({ uci }) => uci),
    ["ease-high", "chance-high", "chance-low"],
  );
  assert.deepEqual(rankByIntent([], "balanced"), []);
});
