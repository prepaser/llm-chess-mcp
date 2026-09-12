import assert from "node:assert/strict";
import test from "node:test";
import { ChessError } from "../src/errors.js";
import { GameStore } from "../src/games.js";
import {
  HttpWorkAdmission,
  withSessionWorkAdmission,
} from "../src/http-work.js";
import type { AppServices } from "../src/services.js";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("HTTP work admission holds capacity until downstream work settles", async () => {
  const admission = new HttpWorkAdmission(1, 1);
  const lifecycle = new AbortController();
  const first = admission.forSession(lifecycle.signal);
  const second = admission.forSession(new AbortController().signal);
  const blocked = deferred();
  const running = first(new AbortController().signal, async () => {
    await blocked.promise;
    return "done";
  });

  await assert.rejects(
    second(new AbortController().signal, async () => "bypassed"),
    (error: unknown) =>
      error instanceof ChessError &&
      error.code === "SERVER_BUSY" &&
      error.message === "server work limit reached",
  );

  blocked.resolve();
  assert.equal(await running, "done");
  assert.equal(
    await second(new AbortController().signal, async () => "admitted"),
    "admitted",
  );
});

test("HTTP work admission enforces session capacity and pre-abort", async () => {
  const admission = new HttpWorkAdmission(2, 1);
  const lifecycle = new AbortController();
  const run = admission.forSession(lifecycle.signal);
  const blocked = deferred();
  const running = run(new AbortController().signal, () => blocked.promise);

  await assert.rejects(
    run(new AbortController().signal, async () => {}),
    (error: unknown) =>
      error instanceof ChessError && error.message === "MCP session work limit reached",
  );

  lifecycle.abort();
  await assert.rejects(
    run(new AbortController().signal, async () => {}),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
  blocked.resolve();
  await assert.rejects(
    running,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("HTTP work admission keeps its legacy session alias", async () => {
  const admission = new HttpWorkAdmission(1, 1);
  const lifecycle = new AbortController();
  const result = await admission.session(lifecycle.signal)(
    new AbortController().signal,
    async () => 42,
  );
  assert.equal(result, 42);
});

test("HTTP work admission preserves class-based service methods and receivers", async () => {
  class ClassServices implements AppServices {
    games = new GameStore();
    enabled = true;
    quitCalls = 0;

    async analyze(..._args: Parameters<AppServices["analyze"]>) {
      return [];
    }

    async humanMoveDistribution(
      ..._args: Parameters<AppServices["humanMoveDistribution"]>
    ) {
      return [];
    }

    explorerEnabled(): boolean {
      return this.enabled;
    }

    async openingExplorer(
      ...args: Parameters<AppServices["openingExplorer"]>
    ) {
      return {
        db: args[1],
        white: 0,
        draws: 0,
        black: 0,
        moves: [],
        opening: null,
      };
    }

    async computeCandidates(
      ..._args: Parameters<AppServices["computeCandidates"]>
    ) {
      return {
        candidates: [],
        moveSensitivity: { level: "low" as const, topMoveSpreadCp: null },
      };
    }

    rankByIntent(...args: Parameters<AppServices["rankByIntent"]>) {
      return args[0];
    }

    async quit(): Promise<void> {
      this.quitCalls += 1;
    }
  }

  const services = new ClassServices();
  const scopedGames = services.games.forScope("bearer:test");
  const admitted = withSessionWorkAdmission(
    services,
    async (_signal, work) => work(new AbortController().signal),
    scopedGames,
  );
  assert.equal(admitted.games, scopedGames);
  assert.notEqual(admitted.games, services.games);
  assert.equal(admitted.explorerEnabled(), true);
  assert.deepEqual(admitted.rankByIntent([], "best"), []);
  await admitted.quit();
  assert.equal(services.quitCalls, 1);
});

test("HTTP work admission forwards optional multi-engine services", async () => {
  let runs = 0;
  let engineCalls = 0;
  let candidateCalls = 0;
  let rankCalls = 0;
  let forwardedRanker: unknown;
  const services = {
    games: new GameStore(),
    analyze: async () => [],
    analyzeEngines: async (..._args: Parameters<NonNullable<AppServices["analyzeEngines"]>>) => {
      engineCalls += 1;
      return undefined as never;
    },
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => ({ db: "lichess" as const, white: 0, draws: 0, black: 0, moves: [], opening: null }),
    computeCandidates: async () => ({ candidates: [], moveSensitivity: { level: "low" as const, topMoveSpreadCp: null } }),
    computeEngineCandidates: async (..._args: Parameters<NonNullable<AppServices["computeEngineCandidates"]>>) => {
      candidateCalls += 1;
      return undefined as never;
    },
    rankEngineCandidates: (...args: Parameters<NonNullable<AppServices["rankEngineCandidates"]>>) => {
      rankCalls += 1;
      forwardedRanker = args[3];
      return [...args[0]];
    },
    rankByIntent: (candidates: never[]) => candidates,
    quit: async () => {},
  } satisfies AppServices;
  const admitted = withSessionWorkAdmission(services, async (_signal, work) => {
    runs += 1;
    return work(new AbortController().signal);
  });

  await admitted.analyzeEngines?.(undefined as never, undefined as never);
  await admitted.computeEngineCandidates?.(undefined as never, 1, undefined as never, 1, null);
  const ranker: AppServices["rankByIntent"] = (candidates) => candidates;
  assert.deepEqual(admitted.rankEngineCandidates?.([], "best", [], ranker), []);
  assert.equal(forwardedRanker, ranker);
  assert.equal(engineCalls, 1);
  assert.equal(candidateCalls, 1);
  assert.equal(rankCalls, 1);
  assert.equal(runs, 2);
});

test("optional engine methods added or replaced later cannot bypass work admission", async () => {
  const services: AppServices = {
    games: new GameStore(),
    analyze: async () => [],
    humanMoveDistribution: async () => [],
    explorerEnabled: () => false,
    openingExplorer: async () => ({ db: "lichess", white: 0, draws: 0, black: 0, moves: [], opening: null }),
    computeCandidates: async () => ({ candidates: [], moveSensitivity: { level: "low", topMoveSpreadCp: null } }),
    rankByIntent: (candidates) => candidates,
    quit: async () => {},
  };
  let runs = 0;
  const seen: string[] = [];
  const admitted = withSessionWorkAdmission(services, async (signal, work) => {
    runs += 1;
    return work(signal);
  });
  assert.equal(admitted.analyzeEngines, undefined);
  assert.equal(admitted.computeEngineCandidates, undefined);
  for (const name of ["first", "replacement"]) {
    services.analyzeEngines = async () => { seen.push(`analyze:${name}`); return undefined as never; };
    services.computeEngineCandidates = async () => { seen.push(`candidates:${name}`); return undefined as never; };
    await (admitted as AppServices).analyzeEngines!(undefined as never, undefined as never);
    await (admitted as AppServices).computeEngineCandidates!(undefined as never, 1500, undefined as never, 5);
  }
  assert.equal(runs, 4);
  assert.deepEqual(seen, ["analyze:first", "candidates:first", "analyze:replacement", "candidates:replacement"]);
  delete services.analyzeEngines;
  delete services.computeEngineCandidates;
  assert.equal(admitted.analyzeEngines, undefined);
  assert.equal(admitted.computeEngineCandidates, undefined);
});
