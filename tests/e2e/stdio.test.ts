import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOOL_NAMES } from "../../src/tool-names.js";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const CALL_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

function object(value: unknown): JsonObject {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as JsonObject;
}

function summary(result: ToolResult): string {
  assert.equal(result.content.length, 1);
  const block = result.content[0];
  assert.equal(block?.type, "text");
  if (!block || block.type !== "text") assert.fail("expected text content");
  assert.ok(block.text.length > 0 && block.text.length <= 200);
  assert.throws(() => JSON.parse(block.text), SyntaxError);
  return block.text;
}

function childEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "LICHESS_TOKEN" && entry[1] !== undefined,
    ),
  );
}

function waitForInitialize(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<void> {
  const stdout = child.stdout;
  assert.ok(stdout);
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error(`stdio server did not initialize: ${stderr()}`)),
      CHILD_TIMEOUT_MS,
    );
    stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message: unknown = JSON.parse(line);
          if (
            message &&
            typeof message === "object" &&
            Reflect.get(message, "id") === 1
          ) {
            clearTimeout(timer);
            resolve();
            return;
          }
        } catch (error) {
          clearTimeout(timer);
          reject(error);
          return;
        }
      }
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`stdio server exited early with ${code}/${signal}: ${stderr()}`));
    });
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  stderr: () => string,
): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`stdio server did not stop: ${stderr()}`)),
      CHILD_TIMEOUT_MS,
    );
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve([code, signal]);
    });
  });
}

async function success(
  client: Client,
  name: string,
  args: JsonObject,
): Promise<JsonObject> {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: CALL_TIMEOUT_MS },
  );
  assert.notEqual(result.isError, true, summary(result));
  assert.notEqual(result.structuredContent, undefined);
  return object(result.structuredContent);
}

async function toolError(
  client: Client,
  name: string,
  args: JsonObject,
  code: string,
): Promise<JsonObject> {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: CALL_TIMEOUT_MS },
  );
  assert.equal(result.isError, true);
  summary(result);
  const error = object(object(result.structuredContent).error);
  assert.equal(error.code, code);
  assert.equal(typeof error.message, "string");
  return error;
}

test(
  "stdio exposes and executes the complete structured chess protocol",
  { timeout: 120_000 },
  async () => {
    const env = childEnv();
    assert.equal("LICHESS_TOKEN" in env, false);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/index.js"],
      cwd: REPO,
      env,
    });
    const client = new Client({ name: "stdio-e2e", version: "1.0.0" });

    try {
      await client.connect(transport);

      const listed = await client.listTools(undefined, {
        timeout: CALL_TIMEOUT_MS,
      });
      assert.equal(listed.tools.length, 13);
      assert.deepEqual(
        listed.tools.map(({ name }) => name).sort(),
        [...TOOL_NAMES].sort(),
      );
      for (const tool of listed.tools) {
        assert.ok(tool.outputSchema, `${tool.name} has no outputSchema`);
      }

      const created = await success(client, "create_game", {});
      assert.equal(typeof created.game_id, "string");
      assert.equal(created.revision, 0);
      const gameId = created.game_id as string;

      const state = await success(client, "game_state", {
        game_id: gameId,
        include_ascii: true,
      });
      assert.equal(state.revision, 0);
      assert.equal(state.turn, "w");
      assert.equal(typeof state.board, "string");
      assert.deepEqual(state.history, []);

      const legal = await success(client, "game_legal_moves", {
        game_id: gameId,
      });
      assert.equal(legal.revision, 0);
      assert.equal(legal.count, 20);
      assert.ok(
        (legal.moves as JsonObject[]).some((move) => move.uci === "e2e4"),
      );

      const played = await success(client, "game_play_move", {
        game_id: gameId,
        move: "e4",
        expected_revision: state.revision,
      });
      assert.equal(played.move, "e4");
      assert.equal(played.revision, 1);
      assert.deepEqual(played.history, ["e4"]);

      const analyzed = await success(client, "position_analyze", {
        game_id: gameId,
        analysis_level: "fast",
        depth: 1,
        multipv: 1,
      });
      assert.equal(analyzed.revision, 1);
      assert.equal((analyzed.lines as unknown[]).length, 1);
      assert.ok(Array.isArray((analyzed.lines as JsonObject[])[0]?.pvSan));

      const human = await success(client, "human_move_distribution", {
        game_id: gameId,
        elo: 1500,
        top_n: 1,
      });
      assert.equal(human.revision, 1);
      assert.equal((human.moves as unknown[]).length, 1);

      const evaluated = await success(client, "move_evaluate", {
        game_id: gameId,
        move: "e5",
        depth: 1,
      });
      assert.equal(evaluated.revision, 1);
      assert.equal((evaluated.results as unknown[]).length, 1);
      assert.equal((evaluated.results as JsonObject[])[0]?.move, "e5");
      assert.ok(Array.isArray((evaluated.results as JsonObject[])[0]?.pvSan));

      const candidateArgs = {
        game_id: gameId,
        elo: 1500,
        analysis_level: "fast",
        sf_depth: 1,
        sf_multipv: 1,
        maia_top_n: 1,
      };
      const candidates = await success(client, "move_candidates", candidateArgs);
      const candidateList = candidates.candidates as JsonObject[];
      assert.equal(candidates.analysis_level, "fast");
      assert.ok(candidateList.length > 0);
      assert.ok(
        candidateList.every(
          (candidate) => object(candidate.opening).status === "disabled",
        ),
      );

      const byIntent = await success(client, "move_candidates_by_intent", {
        ...candidateArgs,
        intent: "best",
      });
      assert.equal(byIntent.intent, "best");
      assert.ok((byIntent.candidates as unknown[]).length > 0);

      const exported = await success(client, "game_pgn", { game_id: gameId });
      assert.equal(exported.revision, 1);
      assert.match(exported.pgn as string, /\be4\b/);

      const imported = await success(client, "game_import_pgn", {
        pgn: exported.pgn,
      });
      assert.equal(typeof imported.game_id, "string");
      assert.notEqual(imported.game_id, gameId);
      assert.equal(imported.revision, 0);
      assert.deepEqual(imported.history, ["e4"]);
      const importedGameId = imported.game_id as string;

      await toolError(
        client,
        "opening_explorer",
        { game_id: gameId },
        "LICHESS_DISABLED",
      );
      const invalidInput = await client.callTool({
        name: "opening_explorer",
        arguments: { game_id: gameId, db: "masters", speeds: ["rapid"] },
      });
      assert.equal(invalidInput.isError, true);
      assert.equal(invalidInput.structuredContent, undefined);
      assert.match(
        (invalidInput.content[0] as { type: "text"; text: string }).text,
        /^Input validation error:/,
      );

      const deleted = await success(client, "delete_game", { game_id: gameId });
      assert.deepEqual(deleted, { game_id: gameId, deleted: true });
      await success(client, "delete_game", { game_id: importedGameId });
      await toolError(
        client,
        "game_state",
        { game_id: gameId },
        "GAME_NOT_FOUND",
      );
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
      assert.equal(transport.pid, null);
    }
  },
);

test(
  "stdio CLI shuts down cleanly on SIGTERM",
  { timeout: 30_000 },
  async () => {
    const child = spawn(process.execPath, ["dist/index.js"], {
      cwd: REPO,
      env: childEnv(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    assert.ok(child.stdin);
    assert.ok(child.stderr);
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = waitForExit(child, () => stderr);

    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "stdio-signal-e2e", version: "1.0.0" },
          },
        })}\n`,
      );
      await waitForInitialize(child, () => stderr);
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);
