import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const REPO = fileURLToPath(new URL("../..", import.meta.url));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

test(
  "CLI serves Streamable HTTP and shuts down cleanly",
  { timeout: 30_000 },
  async () => {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}/mcp`;
    const child = spawn(
      process.execPath,
      ["dist/index.js", "--transport", "http", "--port", String(port)],
      {
        cwd: REPO,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] =>
              entry[0] !== "LICHESS_TOKEN" && entry[1] !== undefined,
          ),
        ),
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
    const exited = new Promise<[number | null, NodeJS.Signals | null]>((resolve) =>
      child.once("exit", (code, signal) => resolve([code, signal])),
    );

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`HTTP server did not start: ${stderr}`)),
        10_000,
      );
      child.stderr.on("data", () => {
        if (!stderr.includes(`listening on ${endpoint}`)) return;
        clearTimeout(timer);
        resolve();
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`HTTP server exited early with ${code}: ${stderr}`));
      });
    });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    const client = new Client({ name: "http-cli-e2e", version: "1.0.0" });

    try {
      await ready;
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
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  },
);
