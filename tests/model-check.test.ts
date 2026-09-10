import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const CHECKER = new URL("../scripts/model-check.mjs", import.meta.url);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "llm-chess-model-check-"));
  const models = join(root, "models");
  await mkdir(models);
  const config = {
    schemaVersion: 3,
    analysis: { mode: "both" },
    maia3: {
      model: "5m",
      source: {
        type: "huggingface",
        repoId: "example/maia3",
        filename: "maia3-5m.pt",
        revision: "0123456789abcdef0123456789abcdef01234567",
      },
    },
    stockfish: {
      version: "18.0.8",
      flavor: "lite-single",
    },
    lc0: {
      version: "0.32.1",
      weights: { url: "https://example.invalid/weights.pb.gz", sha256: sha256("weights") },
      backend: "cpu",
      platforms: ["linux-x64", "win32-x64"],
    },
  };
  const model = "onnx-model";
  const data = "external-data";
  await writeFile(join(root, "model.config.json"), JSON.stringify(config));
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "llm-chess-mcp-fixture",
    dependencies: { stockfish: "18.0.8" },
    stockfish: { flavor: "lite-single" },
    analysis: { mode: "both" },
  }));
  await mkdir(join(root, "node_modules", "stockfish"), { recursive: true });
  await writeFile(join(root, "node_modules", "stockfish", "package.json"), JSON.stringify({
    name: "stockfish",
    version: "18.0.8",
  }));
  await writeFile(join(models, "maia3.onnx"), model);
  await writeFile(join(models, "maia3.onnx.data"), data);
  await writeFile(
    join(models, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      model: "5m",
      config: {
        schemaVersion: 1,
        model: config.maia3.model,
        source: config.maia3.source,
      },
      checkpointSha256: sha256("checkpoint"),
      modelFile: "maia3.onnx",
      files: [
        { path: "maia3.onnx", sha256: sha256(model) },
        { path: "maia3.onnx.data", sha256: sha256(data) },
      ],
    }),
  );
  const lc0 = join(root, "bundle", "lc0");
  await mkdir(join(lc0, "weights"), { recursive: true });
  await mkdir(join(lc0, "linux-x64"), { recursive: true });
  await mkdir(join(lc0, "win32-x64"), { recursive: true });
  await writeFile(join(lc0, "weights", "network.pb.gz"), "weights");
  await writeFile(join(lc0, "linux-x64", "lc0"), "linux");
  await writeFile(join(lc0, "win32-x64", "lc0.exe"), "windows");
  await writeFile(join(lc0, "manifest.json"), JSON.stringify({
    schemaVersion: 1,
    engineVersion: "0.32.1",
    weights: { path: "weights/network.pb.gz", sha256: sha256("weights") },
    platforms: {
      "linux-x64": { executable: "linux-x64/lc0", backend: "blas", files: [{ path: "linux-x64/lc0", sha256: sha256("linux") }] },
      "win32-x64": { executable: "win32-x64/lc0.exe", backend: "blas", files: [{ path: "win32-x64/lc0.exe", sha256: sha256("windows") }] },
    },
  }));
  return { root, models };
}

async function run(root: string, models: string) {
  return execFile(process.execPath, [
    fileURLToPath(CHECKER),
    "--config",
    join(root, "model.config.json"),
    "--models",
    models,
  ], { encoding: "utf8" });
}

test("model check validates a manifest-backed ONNX bundle", async () => {
  const { root, models } = await fixture();
  try {
    const result = await run(root, models);
    assert.match(result.stdout, /model check passed: 5m \(2 files\)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check compares config structurally and rejects drift and unsafe paths", async () => {
  const { root, models } = await fixture();
  try {
    const configPath = join(root, "model.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(configPath, JSON.stringify({ source: config.maia3.source, model: config.maia3.model, schemaVersion: 1 }));
    await assert.rejects(run(root, models), /config has invalid fields|config.schemaVersion/);
    await writeFile(configPath, JSON.stringify({ ...config, maia3: { ...config.maia3, model: "3m" } }));
    await assert.rejects(run(root, models), /does not match config.model/);
    await writeFile(configPath, JSON.stringify(config));
    const manifestPath = join(models, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    for (const path of ["../outside", "nested/../outside", "C:/outside", "./model.onnx"]) {
      await writeFile(manifestPath, JSON.stringify({ ...manifest, files: [{ path, sha256: sha256("file") }] }));
      await assert.rejects(run(root, models), /relative.*path/);
    }
    await writeFile(manifestPath, JSON.stringify(manifest));
    await rm(join(models, "maia3.onnx.data"));
    await assert.rejects(run(root, models), /file is missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check validates Stockfish metadata and installed version", async () => {
  const { root, models } = await fixture();
  try {
    const packagePath = join(root, "package.json");
    const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
    await writeFile(packagePath, JSON.stringify({ ...packageJson, dependencies: { stockfish: "^18.0.8" } }));
    await assert.rejects(run(root, models), /Stockfish dependency does not match/);
    await writeFile(packagePath, JSON.stringify(packageJson));
    await writeFile(join(root, "node_modules", "stockfish", "package.json"), JSON.stringify({ name: "stockfish", version: "17.0.0" }));
    await assert.rejects(run(root, models), /Stockfish installed version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check rejects the legacy root schema", async () => {
  const { root, models } = await fixture();
  try {
    await writeFile(join(root, "model.config.json"), JSON.stringify({
      schemaVersion: 1,
      model: "5m",
      source: { type: "local", path: "weights.pt" },
    }));
    await assert.rejects(run(root, models), /config has invalid fields|config.schemaVersion/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check rejects tampered and unlisted artifacts", async () => {
  const { root, models } = await fixture();
  try {
    await writeFile(join(models, "maia3.onnx"), "tampered");
    await assert.rejects(run(root, models), (error: unknown) =>
      typeof error === "object" && error !== null && "stderr" in error &&
      String(error.stderr).includes("SHA-256 mismatch"));

    const clean = await fixture();
    try {
      await writeFile(join(clean.models, "extra.bin"), "unlisted");
      await assert.rejects(run(clean.root, clean.models), (error: unknown) =>
        typeof error === "object" && error !== null && "stderr" in error &&
        String(error.stderr).includes("unlisted model artifact"));
    } finally {
      await rm(clean.root, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("model check validates the configured Lc0 bundle", async () => {
  const { root, models } = await fixture();
  try {
    const manifestPath = join(root, "bundle", "lc0", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, engineVersion: "0.31.0" }));
    await assert.rejects(run(root, models), /engine version does not match config/);
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, "bundle", "lc0", "weights", "network.pb.gz"), "tampered");
    await assert.rejects(run(root, models), /SHA-256 mismatch for lc0\/weights/);
    await writeFile(join(root, "bundle", "lc0", "weights", "network.pb.gz"), "weights");
    await writeFile(manifestPath, JSON.stringify(manifest));
    await writeFile(join(root, "bundle", "lc0", "unlisted.bin"), "unlisted");
    await assert.rejects(run(root, models), /unlisted Lc0 artifact/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
