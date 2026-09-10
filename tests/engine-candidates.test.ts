import assert from "node:assert/strict";
import test from "node:test";
import { Chess } from "chess.js";
import {
  candidateSetFromEngineAnalysis,
  createEngineCandidateComputation,
  rankEngineCandidates,
  type MultiEngineCandidate,
} from "../src/engine-consensus.js";
import type { EngineAnalysis } from "../src/engines/types.js";
import type { Maia3Move, SfLine } from "../src/domain.js";

function line(uci: string, cp: number, multipv: number): SfLine {
  return { scoreCp: cp, scoreMate: null, wdl: null, pv: [uci], multipv };
}

function analysis(
  stockfish: SfLine[] | null,
  lc0: SfLine[] | null,
): EngineAnalysis {
  const ok = (id: "stockfish" | "lc0", result: SfLine[]) => ({
    status: "ok" as const,
    meta: { id, version: "test", weightsSha256: null, backend: "test" },
    result,
    elapsedMs: 1,
    limits: { depth: id === "stockfish" ? 1 : null, movetimeMs: id === "lc0" ? 1 : null, multipv: 2 },
  });
  const error = { status: "error" as const, error: { code: "TEST", message: "failed" } };
  const enginesUsed = [stockfish ? "stockfish" : null, lc0 ? "lc0" : null].filter(
    (id): id is "stockfish" | "lc0" => id !== null,
  );
  return {
    mode: "both",
    partial: enginesUsed.length === 1,
    enginesUsed,
    engines: {
      stockfish: stockfish ? ok("stockfish", stockfish) : error,
      lc0: lc0 ? ok("lc0", lc0) : error,
    },
  };
}

const opening = {
  status: "disabled" as const,
  games: null,
  frequency: null,
  white: null,
  draws: null,
  black: null,
  averageRating: null,
};
const openingData = { status: "disabled" as const, totalGames: null, moves: [] as const };
const human = (moves: Maia3Move[]): Maia3Move[] => moves;

test("fuses per-engine objectives without losing engine-specific scores", () => {
  const chess = new Chess();
  const result = candidateSetFromEngineAnalysis(
    chess,
    1500,
    analysis([line("e2e4", 100, 1), line("d2d4", 50, 2)], [line("d2d4", 80, 1), line("g1f3", 40, 2)]),
    human([{ uci: "e2e4", san: "e4", prob: 0.5 }, { uci: "d2d4", san: "d4", prob: 0.3 }]),
    openingData,
    2,
  );
  const e4 = result.candidates.find((candidate) => candidate.uci === "e2e4")!;
  const d4 = result.candidates.find((candidate) => candidate.uci === "d2d4")!;
  assert.equal(e4.objective.byEngine.stockfish?.moverCp, 100);
  assert.equal(e4.objective.byEngine.lc0, null);
  assert.equal(d4.objective.byEngine.stockfish?.moverCp, 50);
  assert.equal(d4.objective.byEngine.lc0?.moverCp, 80);
  assert.equal(result.moveSensitivity.stockfish?.topMoveSpreadCp, 50);
  assert.equal(result.moveSensitivity.lc0?.topMoveSpreadCp, 40);
});

test("uses reciprocal-rank fusion and deterministic support tie breaks", () => {
  const candidate = (uci: string, prob: number): MultiEngineCandidate => ({
    uci,
    san: uci,
    objective: {
      byEngine: {
        stockfish: { rank: uci === "a" ? 1 : 2, moverCp: uci === "a" ? 100 : 90, whiteCp: uci === "a" ? 100 : 90, cpLoss: 0, moverMate: null, whiteMate: null, wdl: null },
        lc0: { rank: uci === "b" ? 1 : 2, moverCp: uci === "b" ? 100 : 90, whiteCp: uci === "b" ? 100 : 90, cpLoss: 0, moverMate: null, whiteMate: null, wdl: null },
      },
    },
    human: { maia3Prob: prob, selfElo: 1500, opponentElo: 1500 },
    opening,
    consensusRank: null,
    consensusScore: 0,
    support: 0,
  });
  const ranked = rankEngineCandidates([candidate("a", 0.2), candidate("b", 0.1)], "best", ["stockfish", "lc0"]);
  assert.deepEqual(ranked.map(({ uci }) => uci), ["a", "b"]);
  assert.equal(ranked[0]?.support, 2);
  assert.equal(ranked[0]?.consensusRank, 1);
  assert.equal(ranked[0]?.consensusScore, ranked[1]?.consensusScore);
});

test("fusion preserves each engine's rank when intent scores tie", () => {
  const result = candidateSetFromEngineAnalysis(new Chess(), 1500,
    analysis([line("e2e4", 20, 1), line("d2d4", 20, 2)],
      [line("d2d4", 20, 1), line("e2e4", 20, 2)]),
    [{ uci: "e2e4", san: "e4", prob: 0.5 }, { uci: "d2d4", san: "d4", prob: 0.5 }],
    openingData, 2);
  const original = structuredClone(result.candidates);
  for (const candidates of [result.candidates, [...result.candidates].reverse()]) {
    for (const intent of ["best", "strong", "balanced"] as const) {
      const ranked = rankEngineCandidates(candidates, intent, result.enginesUsed);
      assert.deepEqual(ranked.map(({ uci }) => uci), ["d2d4", "e2e4"]);
      for (const candidate of ranked) {
        assert.equal(candidate.support, 2);
        assert.equal(candidate.consensusScore, (1 / 61 + 1 / 62) / 2);
      }
    }
    assert.equal(rankEngineCandidates(candidates, "best", ["lc0"])[0]?.uci, "d2d4");
    assert.equal(rankEngineCandidates(candidates, "best", ["stockfish"])[0]?.uci, "e2e4");
  }
  assert.deepEqual(result.candidates, original);
});

test("natural intent remains Maia ordering and does not require an engine", () => {
  const make = (uci: string, prob: number): MultiEngineCandidate => ({
    uci, san: uci,
    objective: { byEngine: { stockfish: null, lc0: null } },
    human: { maia3Prob: prob, selfElo: 1500, opponentElo: 1500 }, opening,
    consensusRank: null, consensusScore: 0, support: 0,
  });
  assert.deepEqual(rankEngineCandidates([make("b", 0.2), make("a", 0.8)], "natural", []).map(({ uci }) => uci), ["a", "b"]);
});

test("balanced fusion does not count an unassessed human move as engine support", () => {
  const result = candidateSetFromEngineAnalysis(new Chess(), 1500,
    analysis([line("e2e4", 10, 1)], [line("g1f3", 10, 1)]),
    [{ uci: "e2e4", san: "e4", prob: 0.4 }, { uci: "d2d4", san: "d4", prob: 0.6 }], openingData, 2);
  const ranked = rankEngineCandidates(result.candidates, "balanced", result.enginesUsed);
  assert.deepEqual(ranked.map((candidate) => candidate.uci), ["e2e4", "g1f3"]);
  assert.equal(ranked[0]?.support, 1);
  assert.equal(ranked[0]?.consensusScore, 1 / 61 / 2);
  assert.equal(rankEngineCandidates(result.candidates, "natural", result.enginesUsed)[0]?.uci, "d2d4");
});

test("candidate computation gives each provider an isolated position snapshot", async () => {
  const chess = new Chess();
  const original = chess.fen();
  const compute = createEngineCandidateComputation({
    async analyzeEngines(position) {
      position.move("e4");
      return analysis([line("e2e4", 10, 1)], [line("d2d4", 10, 1)]);
    },
    async humanMoveDistribution(position) {
      assert.equal(position.fen(), original);
      position.move("d4");
      return [{ uci: "e2e4", san: "e4", prob: 0.4 }];
    },
    explorerEnabled: () => false,
    async openingExplorer() { throw new Error("unexpected explorer call"); },
    explorerFailureReason: () => "upstream",
  });
  const result = await compute(chess, 1500, { mode: "both", depth: 1, multipv: 2, movetimeMs: 1 }, 2);
  assert.equal(chess.fen(), original);
  assert.deepEqual(result.candidates.map((candidate) => candidate.uci).sort(), ["d2d4", "e2e4"]);
});
