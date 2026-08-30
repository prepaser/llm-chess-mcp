import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { childLifecycle, cleanupChild } from "./child-lifecycle.mjs";

const execFile = promisify(execFileCallback);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_PATH = join(REPO, "spec", "tools.json");
const TIMEOUT_MS = 90_000;
const CHILD_EXIT_TIMEOUT_MS = 10_000;
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

function envValue(name) {
  return Object.entries(process.env).find(
    ([key, value]) => key.toLowerCase() === name.toLowerCase() && value,
  )?.[1];
}

async function npmInvocation(args) {
  if (process.platform !== "win32") return { command: "npm", args };

  const npmExecPath = envValue("npm_execpath");
  const roots = new Set([
    dirname(process.execPath),
    ...(envValue("PATH") ?? "").split(delimiter).filter(Boolean),
  ]);
  const candidates = [
    ...(npmExecPath && /npm-cli\.(?:c?js)$/i.test(npmExecPath)
      ? [npmExecPath]
      : []),
    ...[...roots].flatMap((root) => [
      join(root, "node_modules", "npm", "bin", "npm-cli.js"),
      join(root, "node_modules", "npm", "bin", "npm-cli.cjs"),
    ]),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.F_OK);
      return { command: process.execPath, args: [candidate, ...args] };
    } catch {}
  }
  throw new Error("npm CLI JavaScript entry was not found");
}

function serverInvocation(bin, packageRoot, args = []) {
  return process.platform === "win32"
    ? {
        command: process.execPath,
        args: [join(packageRoot, "dist", "index.js"), ...args],
      }
    : { command: bin, args };
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
  const npm = await npmInvocation([
    "--cache",
    cache,
    "pack",
    "--json",
    "--ignore-scripts",
    "--pack-destination",
    workspace,
  ]);
  const { stdout } = await command(
    npm.command,
    npm.args,
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

async function verifyInstalledBin(bin, packageRoot) {
  await access(
    bin,
    process.platform === "win32" ? constants.F_OK : constants.X_OK,
  );
  if (process.platform !== "win32") return;

  const entry = join(packageRoot, "dist", "index.js");
  const target = relative(dirname(bin), entry).replaceAll("/", "\\").toLowerCase();
  const shim = (await readFile(bin, "utf8")).replaceAll("/", "\\").toLowerCase();
  assert.ok(shim.includes(target), "installed Windows bin does not target dist/index.js");
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
  const missingEntry = join(install, ".missing-entry");

  await command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'const token = process.env.LICHESS_TOKEN; const dlopen = process.dlopen; let nativeLoads = 0; process.dlopen = (...args) => { nativeLoads += 1; return dlopen(...args); }; const api = await import("llm-chess-mcp"); for (const name of ["buildServer", "serveHttp", "ChessError", "ExplorerError", "GameStore", "parseImportedPgn", "pgnOf", "snapshotChess"]) if (typeof api[name] !== "function") throw new Error(`root API is missing ${name}`); const custom = api.buildServer({}); await custom.close(); const chess = api.parseImportedPgn("1.e4 *"); if (!api.pgnOf(chess).includes("e4")) throw new Error("root PGN API is incomplete"); if (process.env.LICHESS_TOKEN !== token) throw new Error("root import loaded .env"); if (nativeLoads !== 0) throw new Error("root API loaded a native addon");',
      missingEntry,
    ],
    install,
  );

  await command(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import assert from "node:assert/strict"; const { toolResult } = await import("llm-chess-mcp/dist/tool-result.js"); const modern = toolResult({ value: 1 }, "modern"); const legacy = toolResult({}, { value: 2 }, "legacy"); assert.deepEqual(modern, { content: [{ type: "text", text: "modern" }], structuredContent: { value: 1 } }); assert.deepEqual(legacy, { content: [{ type: "text", text: "legacy" }], structuredContent: { value: 2 } });',
      missingEntry,
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
  env.LICHESS_TOKEN = "";
  env.MAIA3_MODEL = "5m";
  env.STOCKFISH_FLAVOR = "lite-single";
  return env;
}

async function smoke(bin, packageRoot, cwd) {
  const invocation = serverInvocation(bin, packageRoot);
  const transport = new StdioClientTransport({
    command: invocation.command,
    args: invocation.args,
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
    assert.ok(
      candidates.candidates.every((candidate) => candidate.opening.status === "disabled"),
      "move_candidates unexpectedly enabled Lichess",
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

async function smokeHttp(bin, packageRoot, cwd) {
  const invocation = serverInvocation(bin, packageRoot, [
    "--transport",
    "http",
    "--port",
    "0",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd,
    env: serverEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const lifecycle = childLifecycle(child);
  let endpoint;
  const ready = new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onData);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`packed HTTP server did not start: ${stderr}`)),
      TIMEOUT_MS,
    );
    const onData = () => {
      endpoint = /^llm-chess-mcp listening on (http:\/\/\S+)$/m.exec(stderr)?.[1];
      if (endpoint === undefined) return;
      finish();
    };
    child.stderr.on("data", onData);
    void lifecycle.exited.then(
      ([code, signal]) =>
        finish(
          new Error(
            `packed HTTP server exited early with ${code ?? signal}: ${stderr}`,
          ),
        ),
      (error) => finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
  const client = new Client({ name: "package-http-smoke", version: "1.0.0" });
  let primaryError;

  try {
    await ready;
    assert.ok(endpoint);
    const transport = new StreamableHTTPClientTransport(new URL(endpoint));
    await client.connect(transport);
    assertToolCatalog(await client.listTools(undefined, { timeout: TIMEOUT_MS }));
    const created = await call(client, "create_game", {});
    assert.equal(typeof created.game_id, "string");
    await client.close();
    const [code, signal] = await lifecycle.stop(
      "SIGTERM",
      CHILD_EXIT_TIMEOUT_MS,
      "packed HTTP server",
    );
    assert.ok(
      (code === 0 && signal === null) ||
        (process.platform === "win32" && code === null && signal === "SIGTERM"),
      stderr,
    );
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    await client.close().catch(() => {});
    await cleanupChild(
      lifecycle,
      CHILD_EXIT_TIMEOUT_MS,
      "packed HTTP server",
      primaryError,
    );
  }
}

const workspaceRoot = resolve(process.env.PACKAGE_SMOKE_TMPDIR ?? tmpdir());
await mkdir(workspaceRoot, { recursive: true });
const workspace = await mkdtemp(join(workspaceRoot, "llm-chess-mcp-package-smoke-"));
try {
  const build = await npmInvocation(["run", "build"]);
  await command(build.command, build.args, REPO);
  const cache = join(workspace, "npm-cache");
  const tarball = await pack(workspace, cache);
  const install = join(workspace, "install");
  await mkdir(install);
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  const npm = await npmInvocation([
    "--cache",
    cache,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--omit=dev",
    "--package-lock=false",
    tarball,
  ]);
  await command(npm.command, npm.args, install);
  await verifyPackageApi(install);

  const packageRoot = join(install, "node_modules", "llm-chess-mcp");
  const bin = join(
    install,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "llm-chess-mcp.cmd" : "llm-chess-mcp",
  );
  await verifyInstalledBin(bin, packageRoot);
  await smoke(bin, packageRoot, workspace);
  await smokeHttp(bin, packageRoot, workspace);
  await assert.rejects(access(join(workspace, ":memory:.ses")), {
    code: "ENOENT",
  });
  console.log("package smoke passed");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
