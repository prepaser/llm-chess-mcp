import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after } from "node:test";

const { prepareLc0, platformKey, validateLc0Config } = await import(new URL("../scripts/lc0-prepare.mjs", import.meta.url).href);
const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
async function temporary(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const config = {
  version: "0.32.1",
  weights: {
    url: "https://example.test/network.pb.gz",
    sha256: "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d",
  },
  backend: "cpu",
  platforms: ["win32-x64"],
};

const fixturePreparation = {
  downloadImpl: async (_url: string, destination: string) => {
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, "fixture");
  },
  extractImpl: async (_archive: string, directory: string) => {
    for (const name of ["lc0.exe", "dnnl.dll", "mimalloc-override.dll", "mimalloc-redirect.dll"]) {
      await writeFile(join(directory, name), name);
    }
    return directory;
  },
  probeImpl: async () => "uciok",
};

test("validates the configured Lc0 platform and rejects unsupported values", () => {
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.throws(() => platformKey("darwin", "x64"), /unsupported Lc0 platform/);
  assert.doesNotThrow(() => validateLc0Config(config));
  assert.throws(() => validateLc0Config({ ...config, weights: { ...config.weights, sha256: "bad" } }), /SHA-256/);
  assert.throws(() => validateLc0Config({ ...config, platforms: ["win32-x64", "win32-x64"] }), /unique/);
});

test("prepares a Windows bundle and records hashed runtime files", async () => {
  const root = await temporary("lc0-prepare-");
  const outputDir = join(root, "bundle", "lc0");
  const oldDir = join(root, "old");
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, "keep"), "old");
  const downloads: string[] = [];
  const manifest = await prepareLc0({
    ...fixturePreparation,
    root,
    config,
    outputDir,
    downloadImpl: async (_url: string, destination: string) => {
      downloads.push(destination);
      await fixturePreparation.downloadImpl(_url, destination);
    },
  });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.engineVersion, "0.32.1");
  assert.equal(manifest.weights.sha256, "f16d05ec6b29248d2c61adb1e9263f78e4f7bace1b955014a2d17872cfe4064d");
  assert.equal(manifest.platforms["win32-x64"].executable, "win32-x64/lc0.exe");
  assert.equal(manifest.platforms["win32-x64"].files.length, 5);
  assert.equal(downloads.length, 2);
  assert.equal(await readFile(join(outputDir, "win32-x64", "lc0.exe"), "utf8"), "lc0.exe");
});

test("rejects partial platform preparation before modifying an existing bundle", async () => {
  const root = await temporary("lc0-prepare-subset-");
  const outputDir = join(root, "bundle", "lc0");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "manifest.json"), "old");
  let downloaded = false;
  await assert.rejects(prepareLc0({
    root, config: { ...config, platforms: ["linux-x64", "win32-x64"] },
    platforms: ["win32-x64"],
    downloadImpl: async () => { downloaded = true; },
  }), /all configured Lc0 platforms/);
  assert.equal(downloaded, false);
  assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), "old");
});

test("prepares from an unchanged root configuration", async () => {
  const root = await temporary("lc0-prepare-config-");
  const fullConfig = JSON.parse(await readFile(new URL("../model.config.json", import.meta.url), "utf8"));
  fullConfig.lc0 = config;
  await writeFile(join(root, "model.config.json"), JSON.stringify(fullConfig));
  const manifest = await prepareLc0({ root, ...fixturePreparation });
  assert.deepEqual(Object.keys(manifest.platforms), config.platforms);
});

test("configuration drift or deletion preserves the existing bundle", async () => {
  for (const change of ["edit", "delete"] as const) {
    const root = await temporary("lc0-prepare-config-drift-");
    const configPath = join(root, "model.config.json");
    const outputDir = join(root, "bundle", "lc0");
    const fullConfig = JSON.parse(await readFile(new URL("../model.config.json", import.meta.url), "utf8"));
    fullConfig.lc0 = config;
    await writeFile(configPath, JSON.stringify(fullConfig));
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "manifest.json"), "old");
    await assert.rejects(prepareLc0({
      root, ...fixturePreparation,
      probeImpl: async () => {
        if (change === "delete") await rm(configPath);
        else {
          fullConfig.lc0 = { ...config, version: "0.32.2" };
          await writeFile(configPath, JSON.stringify(fullConfig));
        }
      },
    }), (error: unknown) => error instanceof Error && /existing bundle was preserved/.test(error.message)
      && error.cause instanceof Error
      && (change === "edit" ? /configuration changed/.test(error.cause.message) : /ENOENT/.test(error.cause.message)));
    assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), "old");
  }
});

test("preserves an existing bundle when preparation fails", async () => {
  const root = await temporary("lc0-prepare-failure-");
  const outputDir = join(root, "bundle", "lc0");
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "manifest.json"), "old");
  await assert.rejects(
    prepareLc0({ root, config, outputDir, downloadImpl: async () => { throw new Error("offline"); } }),
    /existing bundle was preserved/,
  );
  assert.equal(await readFile(join(outputDir, "manifest.json"), "utf8"), "old");
});

test("does not silently substitute a CPU bundle for CUDA", async () => {
  const root = await temporary("lc0-prepare-cuda-");
  const cudaConfig = { ...config, backend: "cuda", platforms: ["linux-x64"] };
  await assert.rejects(
    prepareLc0({
      root, config: cudaConfig, platforms: ["linux-x64"],
      downloadImpl: async (_url: string, destination: string) => {
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, "fixture");
      },
    }),
    (error: unknown) => error instanceof Error && error.cause instanceof Error && /LC0_LINUX_BUNDLE/.test(error.cause.message),
  );
});
