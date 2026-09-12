import assert from "node:assert/strict";
import test from "node:test";
import { GameStore } from "../src/games.js";
import { decorateAppServices } from "../src/service-decorator.js";
import type { AppServices } from "../src/services.js";

test("decorateAppServices preserves receivers and optional methods", async () => {
  class Services implements AppServices {
    games = new GameStore();
    enabled = true;
    calls = 0;

    analyze() { return Promise.resolve([]); }
    humanMoveDistribution() { return Promise.resolve([]); }
    explorerEnabled() { return this.enabled; }
    openingExplorer() {
      return Promise.resolve({ db: "lichess" as const, white: 0, draws: 0, black: 0, moves: [], opening: null });
    }
    computeCandidates() {
      return Promise.resolve({ candidates: [], moveSensitivity: { level: "low" as const, topMoveSpreadCp: null } });
    }
    rankByIntent(candidates: never[]) { return candidates; }
    quit() { this.calls += 1; return Promise.resolve(); }
    analyzeEngines() { return Promise.resolve(undefined as never); }
    computeEngineCandidates() { return Promise.resolve(undefined as never); }
    rankEngineCandidates(...args: Parameters<NonNullable<AppServices["rankEngineCandidates"]>>) {
      return [...args[0]];
    }
  }

  const source = new Services();
  const decorated = decorateAppServices(source, {
    explorerEnabled: function () {
      assert.equal(this, source);
      return true;
    },
  });

  assert.equal(decorated.explorerEnabled(), true);
  assert.equal(typeof decorated.analyzeEngines, "function");
  await decorated.quit();
  assert.equal(source.calls, 1);
});

test("decorateAppServices retains absent optional methods as absent", () => {
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
  const decorated = decorateAppServices(services);
  assert.equal(decorated.analyzeEngines, undefined);
  assert.equal(decorated.computeEngineCandidates, undefined);
  assert.equal(decorated.rankEngineCandidates, undefined);
  const nextGames = new GameStore();
  services.games = nextGames;
  services.explorerEnabled = () => true;
  let calls = 0;
  services.rankEngineCandidates = () => { calls += 1; return []; };
  assert.equal(decorated.games, nextGames);
  assert.equal(decorated.explorerEnabled(), true);
  assert.deepEqual((decorated as AppServices).rankEngineCandidates?.([], "best", []), []);
  assert.equal(calls, 1);
  delete services.rankEngineCandidates;
  assert.equal(decorated.rankEngineCandidates, undefined);
  services.analyzeEngines = async () => undefined as never;
  const suppressed = decorateAppServices(services, {
    get analyzeEngines() { return undefined; },
  });
  assert.equal(suppressed.analyzeEngines, undefined);
});
