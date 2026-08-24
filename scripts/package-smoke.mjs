import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const execFile = promisify(execFileCallback);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(REPO, "spec", "tools.json");
const TIMEOUT_MS = 90_000;
const contract = JSON.parse(await readFile(CONTRACT_PATH, "utf8"));
assert.ok(Array.isArray(contract.tools), "tool contract has no tools array");
const EXPECTED_TOOLS = contract.tools.map(({ name }) => {
  assert.equal(typeof name, "string", "tool contract contains an invalid name");
  return name;
}).sort();
assert.equal(new Set(EXPECTED_TOOLS).size, EXPECTED_TOOLS.length, "tool contract contains duplicate names");

function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sort(child)]),
  );
}

function asObject(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value;
}

async function command(command, args, cwd) {
  return execFile(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 300_000,
  });
}

async function call(client, name, args) {
  const result = await client.callTool(
    { name, arguments: args },
    { timeout: TIMEOUT_MS },
  );
  assert.notEqual(result.isError, true, `${name} returned an MCP error`);
  assert.notEqual(result.structuredContent, undefined, `${name} has no structured result`);
  return asObject(result.structuredContent);
}

async function pack(workspace, cache) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const { stdout } = await command(
    npm,
    ["--cache", cache, "pack", "--json", "--ignore-scripts", "--pack-destination", workspace],
    REPO,
  );
  const packed = JSON.parse(stdout);
  const result = Array.isArray(packed) ? packed[0] : Object.values(packed)[0];
  assert.equal(typeof result?.filename, "string", "npm pack did not report a tarball");

  const files = new Set(result.files.map((file) => file.path));
  for (const expected of [
    "dist/index.js",
    "dist/index.d.ts",
    "models/maia3-5m.onnx",
    "models/maia3-5m.onnx.data",
    "README.md",
    "LICENSE",
    ".env.example",
    "docs/architecture.md",
  ]) {
    assert.ok(files.has(expected), `tarball is missing ${expected}`);
  }
  for (const forbidden of [
    ".env",
    ".npmrc",
    ".git",
    "node_modules",
    "package-lock.json",
    "pnpm-lock.yaml",
    "scripts",
    "src",
    "tests",
  ]) {
    assert.ok(
      ![...files].some((file) => file === forbidden || file.startsWith(`${forbidden}/`)),
      `tarball unexpectedly contains ${forbidden}`,
    );
  }

  return join(workspace, result.filename);
}

async function verifyPackageApi(install) {
  const packageRoot = join(install, "node_modules", "llm-chess-mcp");
  await access(join(packageRoot, "dist", "index.d.ts"), constants.F_OK);
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.engines?.node, ">=20.3.0");
  assert.equal(manifest.main, "./dist/index.js");
  assert.equal(manifest.types, "./dist/index.d.ts");
  assert.deepEqual(manifest.exports, {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
    "./dist/*": "./dist/*",
    "./package.json": "./package.json",
  });

  await writeFile(join(install, ".env"), "LICHESS_TOKEN=import-side-effect\n");

  await command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const token = process.env.LICHESS_TOKEN; const api = await import("llm-chess-mcp"); if (typeof api.buildServer !== "function" || typeof api.serveHttp !== "function") throw new Error("root API is incomplete"); if (process.env.LICHESS_TOKEN !== token) throw new Error("root import loaded .env");',
    ],
    install,
  );
}

function assertToolCatalog(listed) {
  const tools = listed.tools
    .map(({ name, title, description, inputSchema, outputSchema, annotations }) => ({
      name,
      title,
      description,
      inputSchema,
      outputSchema,
      annotations,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  assert.deepEqual(sort(tools), sort(contract.tools), "packed server tools differ from spec/tools.json");
}

function serverEnv() {
  const env = { ...process.env };
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter);
  delete env.LICHESS_TOKEN;
  delete env.MAIA3_MODEL;
  delete env.STOCKFISH_FLAVOR;
  return env;
}

async function smoke(bin, cwd) {
  const transport = new StdioClientTransport({
    command: bin,
    cwd,
    env: serverEnv(),
  });
  const client = new Client({ name: "package-smoke", version: "1.0.0" });

  try {
    await client.connect(transport);
    const listed = await client.listTools(undefined, { timeout: TIMEOUT_MS });
    assertToolCatalog(listed);

    const created = await call(client, "create_game", {});
    assert.equal(typeof created.game_id, "string");
    const gameId = created.game_id;

    const analysis = await call(client, "position_analyze", {
      game_id: gameId,
      analysis_level: "fast",
      depth: 1,
      multipv: 1,
    });
    const [line] = analysis.lines;
    assert.equal(analysis.revision, 0);
    assert.ok(line && Array.isArray(line.pv) && line.pv.length > 0, "Stockfish returned no PV");
    assert.ok(line.scoreCp !== null || line.scoreMate !== null, "Stockfish returned no score");

    const human = await call(client, "human_move_distribution", {
      game_id: gameId,
      elo: 1500,
      top_n: 1,
    });
    const [humanMove] = human.moves;
    assert.equal(human.revision, 0);
    assert.ok(humanMove && typeof humanMove.uci === "string", "Maia3 returned no move");
    assert.ok(
      typeof humanMove.prob === "number" && humanMove.prob > 0 && humanMove.prob <= 1,
      "Maia3 returned an invalid probability",
    );

    const candidates = await call(client, "move_candidates", {
      game_id: gameId,
      elo: 1500,
      analysis_level: "fast",
      sf_depth: 1,
      sf_multipv: 1,
      maia_top_n: 1,
    });
    assert.equal(candidates.revision, 0);
    assert.ok(candidates.candidates.length > 0, "move_candidates returned no candidates");
    assert.ok(
      candidates.candidates.some((candidate) => candidate.human.maia3Prob !== null),
      "move_candidates did not include Maia3 data",
    );
    assert.ok(
      candidates.candidates.some((candidate) => candidate.objective.rank !== null),
      "move_candidates did not include Stockfish data",
    );
  } finally {
    try {
      await client.close();
    } finally {
      await transport.close();
    }
    assert.equal(transport.pid, null, "packed server did not exit cleanly");
  }
}

function freePort() {
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

async function smokeHttp(bin, cwd) {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  const child = spawn(bin, ["--transport", "http", "--port", String(port)], {
    cwd,
    env: serverEnv(),
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve([code, signal])),
  );
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`packed HTTP server did not start: ${stderr}`)),
      TIMEOUT_MS,
    );
    child.stderr.on("data", () => {
      if (!stderr.includes(`listening on ${endpoint}`)) return;
      clearTimeout(timer);
      resolve();
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`packed HTTP server exited early with ${code}: ${stderr}`));
    });
  });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  const client = new Client({ name: "package-http-smoke", version: "1.0.0" });

  try {
    await ready;
    await client.connect(transport);
    assertToolCatalog(await client.listTools(undefined, { timeout: TIMEOUT_MS }));
    const created = await call(client, "create_game", {});
    assert.equal(typeof created.game_id, "string");
    await client.close();
    child.kill("SIGTERM");
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
  } finally {
    await client.close().catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

const workspaceRoot = resolve(process.env.PACKAGE_SMOKE_TMPDIR ?? tmpdir());
await mkdir(workspaceRoot, { recursive: true });
const workspace = await mkdtemp(join(workspaceRoot, "llm-chess-mcp-package-smoke-"));
try {
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  await command(pnpm, ["build"], REPO);
  const cache = join(workspace, "npm-cache");
  const tarball = await pack(workspace, cache);
  const install = join(workspace, "install");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await mkdir(install);
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await command(
    npm,
    [
      "--cache",
      cache,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--omit=dev",
      "--package-lock=false",
      tarball,
    ],
    install,
  );
  await verifyPackageApi(install);

  const bin = join(
    install,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "llm-chess-mcp.cmd" : "llm-chess-mcp",
  );
  await access(
    bin,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  await smoke(bin, workspace);
  await smokeHttp(bin, workspace);
  console.log("package smoke passed");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
