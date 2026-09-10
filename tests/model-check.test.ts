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
    schemaVersion: 1,
    model: "5m",
    source: {
      type: "huggingface",
      repoId: "example/maia3",
      filename: "maia3-5m.pt",
      revision: "0123456789abcdef0123456789abcdef01234567",
    },
  };
  const model = "onnx-model";
  const data = "external-data";
  await writeFile(join(root, "model.config.json"), JSON.stringify(config));
  await writeFile(join(models, "maia3.onnx"), model);
  await writeFile(join(models, "maia3.onnx.data"), data);
  await writeFile(
    join(models, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      model: "5m",
      config,
      checkpointSha256: sha256("checkpoint"),
      modelFile: "maia3.onnx",
      files: [
        { path: "maia3.onnx", sha256: sha256(model) },
        { path: "maia3.onnx.data", sha256: sha256(data) },
      ],
    }),
  );
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
    await writeFile(configPath, JSON.stringify({ source: config.source, model: config.model, schemaVersion: 1 }));
    await run(root, models);
    await writeFile(configPath, JSON.stringify({ ...config, model: "3m" }));
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
