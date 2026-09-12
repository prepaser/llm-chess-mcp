import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { readManifest, resolveModelPath } from "../src/maia3/model.js";

const source = {
  type: "huggingface",
  repoId: "UofTCSSLab/Maia3-5M",
  filename: "maia3-5m.pt",
  revision: "b6559de2398d7140b985f28fd2c19fb5e47ddabe",
} as const;

const roots: string[] = [];
after(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "llm-chess-model-"));
  roots.push(root);
  return root;
}

function manifest(model = "5m", files = ["maia3-5m.onnx", "maia3-5m.onnx.data"]) {
  return {
    schemaVersion: 1,
    model,
    config: { schemaVersion: 1, model, source },
    checkpointSha256: "a".repeat(64),
    files: files.map((path) => ({ path, sha256: "b".repeat(64) })),
    modelFile: files[0],
  };
}

async function fixture(options: { manifest?: unknown; modelFiles?: string[] } = {}) {
  const root = await tempRoot();
  const models = join(root, "models");
  await mkdir(models);
  for (const file of options.modelFiles ?? ["maia3-5m.onnx", "maia3-5m.onnx.data"]) {
    await writeFile(join(models, file), "model");
  }
  if (options.manifest !== undefined) {
    await writeFile(join(models, "manifest.json"), JSON.stringify(options.manifest));
  }
  return { root, models };
}

test("reads a manifest and selects its model file by default", async () => {
  const { root, models } = await fixture({ manifest: manifest() });
  assert.equal(readManifest(models).model, "5m");
  assert.equal(
    resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "" }),
    join(models, "maia3-5m.onnx"),
  );
  assert.equal(
    resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "5m" }),
    join(models, "maia3-5m.onnx"),
  );
});

test("keeps legacy alternative model lookup without a manifest", async () => {
  const { root, models } = await fixture({ manifest: undefined, modelFiles: ["maia3-3m.onnx"] });
  assert.equal(
    resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "3m" }),
    join(models, "maia3-3m.onnx"),
  );
  assert.throws(
    () => resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "" }),
    /model manifest not found/,
  );
});

test("rejects malformed manifests even for an explicit alternative", async () => {
  const { root, models } = await fixture({
    manifest: { schemaVersion: 1 },
    modelFiles: ["maia3-3m.onnx"],
  });
  assert.throws(
    () => resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "3m" }),
    /invalid Maia3 model manifest/,
  );
});

test("rejects malformed source metadata", async () => {
  const value = manifest() as unknown as { config: { source: Record<string, string> } };
  value.config.source = { ...source, repoId: " " };
  const { models } = await fixture({ manifest: value });
  assert.throws(() => readManifest(models), /invalid Hugging Face source/);

  const badRevision = manifest() as unknown as { config: { source: Record<string, string> } };
  badRevision.config.source = { ...source, revision: "not-a-commit" };
  const revisionFixture = await fixture({ manifest: badRevision });
  assert.throws(() => readManifest(revisionFixture.models), /invalid Hugging Face source/);
});

test("build and runtime preserve source filename whitespace consistently", async () => {
  const { validateModelConfig } = await import(new URL("../scripts/model-check.mjs", import.meta.url).href);
  const config = JSON.parse(await readFile(new URL("../model.config.json", import.meta.url), "utf8"));
  for (const path of [" checkpoint.pt", "checkpoint.pt ", " checkpoint.pt ", "check point.pt"]) {
    for (const metadata of [{ type: "local", path }, { ...source, filename: path }]) {
      const value = { ...manifest(), config: { schemaVersion: 1, model: "5m", source: metadata } };
      assert.doesNotThrow(() => validateModelConfig({ ...config, maia3: { model: "5m", source: metadata } }));
      const { root, models } = await fixture({ manifest: value });
      assert.deepEqual(readManifest(models).config.source, metadata);
      assert.equal(resolveModelPath({ packageModelsDir: models, cwd: root, modelKey: "" }), join(models, "maia3-5m.onnx"));
    }
  }
});

test("build and runtime reject empty or NUL-containing source paths", async () => {
  const { validateModelConfig } = await import(new URL("../scripts/model-check.mjs", import.meta.url).href);
  const config = JSON.parse(await readFile(new URL("../model.config.json", import.meta.url), "utf8"));
  for (const path of ["", " \t ", "checkpoint\0.pt"]) {
    for (const metadata of [{ type: "local", path }, { ...source, filename: path }]) {
      const value = { ...manifest(), config: { schemaVersion: 1, model: "5m", source: metadata } };
      assert.throws(() => validateModelConfig({ ...config, maia3: { model: "5m", source: metadata } }));
      const { models } = await fixture({ manifest: value });
      assert.throws(() => readManifest(models), /invalid Maia3 model manifest/);
    }
  }
});

test("does not use a cwd manifest as the package default", async () => {
  const root = await tempRoot();
  const packageModels = join(root, "package-models");
  const cwdModels = join(root, "models");
  await mkdir(packageModels);
  await mkdir(cwdModels);
  await writeFile(join(cwdModels, "maia3-5m.onnx"), "model");
  await writeFile(join(cwdModels, "manifest.json"), JSON.stringify(manifest()));
  assert.throws(
    () => resolveModelPath({ packageModelsDir: packageModels, cwd: root, modelKey: "" }),
    /model manifest not found/,
  );
});

test("uses a non-5m bundled default and preserves explicit cwd selection", async () => {
  const bundle = await fixture({ manifest: manifest("3m", ["bundle.onnx"]), modelFiles: ["bundle.onnx"] });
  const cwd = await fixture({ modelFiles: ["maia3-23m.onnx"] });
  assert.equal(
    resolveModelPath({ packageModelsDir: bundle.models, cwd: cwd.root, modelKey: "" }),
    join(bundle.models, "bundle.onnx"),
  );
  assert.equal(
    resolveModelPath({ packageModelsDir: bundle.models, cwd: cwd.root, modelKey: "23m" }),
    join(cwd.models, "maia3-23m.onnx"),
  );
  for (const modelKey of [" ", " 3m ", "../payload"]) {
    assert.throws(() => resolveModelPath({ packageModelsDir: bundle.models, modelKey }), /unsupported Maia3 model/);
  }
});

test("rejects missing, traversing, and symlinked manifest files", async () => {
  const missing = await fixture({
    manifest: manifest("5m", ["maia3-5m.onnx", "missing.data"]),
  });
  assert.throws(() => readManifest(missing.models), /model file not found/);

  const traversing = await fixture({ manifest: manifest("5m", ["../outside.onnx"]) });
  assert.throws(() => readManifest(traversing.models), /safe relative path/);

  const linked = await fixture({ manifest: manifest("5m", ["model.onnx"]) });
  const outside = join(linked.root, "outside.onnx");
  await writeFile(outside, "outside");
  await symlink(outside, join(linked.models, "model.onnx"));
  assert.throws(() => readManifest(linked.models), /escapes models directory/);

  const directory = await fixture({ manifest: manifest("5m", ["maia3-5m.onnx"]) });
  await rm(join(directory.models, "maia3-5m.onnx"));
  await mkdir(join(directory.models, "maia3-5m.onnx"));
  assert.throws(() => readManifest(directory.models), /regular file/);
});
