import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  candidateSetFromData,
  computeCandidates,
  computeMoveSensitivity,
  explorerCandidateData,
  rankByIntent,
} from "../src/intents.js";
import { stockfish } from "../src/engines/stockfish.js";
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

test("rethrows caller cancellation from the Lichess fallback", async () => {
  const token = process.env.LICHESS_TOKEN;
  const fetch = globalThis.fetch;
  const analyze = stockfish.analyze;
  const controller = new AbortController();
  const cause = new Error("caller cancelled");
  stockfish.analyze = async () => [];
  process.env.LICHESS_TOKEN = "test-token";
  globalThis.fetch = async (_input, init) =>
    await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
        once: true,
      });
    });

  try {
    const pending = computeCandidates(
      new Chess("7k/6Q1/6K1/8/8/8/8/8 b - - 0 1"),
      1500,
      1,
      1,
      1,
      { db: "lichess", speeds: [], ratings: [] },
      controller.signal,
    );
    controller.abort(cause);

    await assert.rejects(pending, (error: unknown) => error === cause);
  } finally {
    stockfish.analyze = analyze;
    globalThis.fetch = fetch;
    if (token === undefined) delete process.env.LICHESS_TOKEN;
    else process.env.LICHESS_TOKEN = token;
  }
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

test("handles missing scores, empty PVs, SAN fallbacks, and explorer failures", () => {
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

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.san, "not-uci");
  assert.deepEqual(candidates[0]?.opening, {
    status: "unavailable",
    reason: "rate_limited",
    games: null,
    frequency: null,
    white: null,
    draws: null,
    black: null,
    averageRating: null,
  });
  assert.deepEqual(moveSensitivity, { level: "low", topMoveSpreadCp: null });
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
    ["natural", "strong", "best", "unknown"],
  );
  assert.deepEqual(
    rankByIntent(candidates, "balanced").map(({ uci }) => uci),
    ["natural", "best", "strong", "unknown"],
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
