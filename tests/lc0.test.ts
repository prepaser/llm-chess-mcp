import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Lc0, type Lc0Process } from "../src/engines/lc0.js";

class FakeLc0Process extends EventEmitter implements Lc0Process {
  readonly stdout = new EventEmitter();
  readonly stdin = {
    write: (data: string): boolean => {
      for (const command of data.trimEnd().split("\n")) {
        this.commands.push(command);
        if (command === "uci") this.emitOutput("id name Lc0 v0.32.1\noption name MultiPV type spin\noption name UCI_ShowWDL type check\noption name ScoreType type combo var centipawn\nuciok\n");
        else if (command === "isready") this.emitOutput("readyok\n");
        else if (command.startsWith("go movetime")) this.emitOutput("info multipv 1 score cp 31 wdl 500 400 100 pv e2e4 e7e5\nbestmove e2e4\n");
      }
      return true;
    },
  };
  readonly commands: string[] = [];
  killed = false;
  kill(): boolean { this.killed = true; this.emit("exit", 0, null); return true; }
  private emitOutput(output: string): void { queueMicrotask(() => this.stdout.emit("data", output)); }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llm-chess-lc0-"));
  await writeFile(join(root, "lc0"), "binary");
  await writeFile(join(root, "weights.pb"), "weights");
  return {
    root,
    manifest: {
      schemaVersion: 1 as const,
      engineVersion: "0.32.1",
      weights: { path: "weights.pb", sha256: "a".repeat(64) },
      platforms: { [`${process.platform}-${process.arch}`]: { executable: "lc0", backend: "dnnl" } },
    },
  };
}

test("Lc0 performs a UCI handshake without inheriting application credentials", async (t) => {
  const env = globalThis.process.env;
  const bearer = env.HTTP_BEARER;
  const lichess = env.LICHESS_TOKEN;
  env.HTTP_BEARER = "test-bearer";
  env.LICHESS_TOKEN = "test-lichess";
  t.after(() => {
    if (bearer === undefined) delete env.HTTP_BEARER;
    else env.HTTP_BEARER = bearer;
    if (lichess === undefined) delete env.LICHESS_TOKEN;
    else env.LICHESS_TOKEN = lichess;
  });
  const { root, manifest } = await fixture();
  let process: FakeLc0Process | undefined;
  const engine = new Lc0({
    manifest,
    manifestPath: join(root, "manifest.json"),
    spawn: (_executable, args, options) => {
      assert.equal(options.env?.HTTP_BEARER, undefined);
      assert.equal(options.env?.LICHESS_TOKEN, undefined);
      assert.deepEqual(args.slice(1), ["--backend=dnnl", "--config=", "--threads=2", "--minibatch-size=16"]);
      process = new FakeLc0Process();
      return process;
    },
  });
  const lines = await engine.analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", {
    mode: "lc0", depth: 10, multipv: 1, movetimeMs: 10,
  }, ["e2e4"]);
  assert.deepEqual(lines, [{ multipv: 1, scoreCp: 31, scoreMate: null, wdl: [500, 400, 100], pv: ["e2e4", "e7e5"] }]);
  assert.ok(process?.commands.some((command) => command.includes("position fen") && command.includes("moves e2e4")));
  await engine.quit();
  assert.equal(process?.killed, true);
});

test("Lc0 rejects a missing platform bundle", async () => {
  const engine = new Lc0({ manifest: { schemaVersion: 1, engineVersion: "0.32.1", weights: { path: "weights.pb", sha256: "a".repeat(64) }, platforms: {} } });
  await assert.rejects(engine.analyze("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", { mode: "lc0", depth: 1, multipv: 1, movetimeMs: 1 }), /platform is not bundled/);
});
