import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  REPO,
  childEnv,
  killIfRunning,
  waitForExit,
  waitForOutput,
} from "../support/process.js";

test(
  "CLI serves Streamable HTTP and shuts down cleanly",
  { timeout: 30_000 },
  async () => {
    const child = spawn(
      process.execPath,
      ["dist/index.js", "--transport", "http", "--port", "0"],
      {
        cwd: REPO,
        env: childEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exited = waitForExit(child, () => stderr, "HTTP server");
    let endpoint: string | undefined;
    const ready = waitForOutput(
      child,
      "stderr",
      () => {
        endpoint = /^llm-chess-mcp listening on (http:\/\/\S+)$/m.exec(stderr)?.[1];
        return endpoint !== undefined;
      },
      () => stderr,
      "HTTP server",
    );
    const client = new Client({ name: "http-cli-e2e", version: "1.0.0" });

    try {
      await ready;
      assert.ok(endpoint);
      const transport = new StreamableHTTPClientTransport(new URL(endpoint));
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some(({ name }) => name === "create_game"));
      const result = await client.callTool({ name: "create_game", arguments: {} });
      assert.notEqual(result.isError, true);
      assert.ok(result.structuredContent);
      assert.equal(typeof Reflect.get(result.structuredContent, "game_id"), "string");
      await client.close();
      child.kill("SIGTERM");
      const [code, signal] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
      assert.equal(stdout, "");
    } finally {
      await client.close().catch(() => {});
      killIfRunning(child);
    }
  },
);
