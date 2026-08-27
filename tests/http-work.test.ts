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
  const admitted = withSessionWorkAdmission(
    services,
    async (_signal, work) => work(new AbortController().signal),
  );
  assert.equal(admitted.explorerEnabled(), true);
  assert.deepEqual(admitted.rankByIntent([], "best"), []);
  await admitted.quit();
  assert.equal(services.quitCalls, 1);
});
