import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { prepareStockfish, probeStockfish } = await import(new URL("../scripts/stockfish-prepare.mjs", import.meta.url).href);
const { checkStockfishConfig, validateStockfishConfig } = await import(new URL("../scripts/stockfish-config.mjs", import.meta.url).href);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "stockfish-prepare-"));
  const config = {
    schemaVersion: 2,
    maia3: { model: "5m", source: { type: "local", path: "weights.pt" } },
    stockfish: { version: "18.0.8", flavor: "full" },
  };
  const pkg = { type: "module", version: "0.7.2", dependencies: { stockfish: "18.0.7" }, stockfish: { flavor: "lite-single" }, unrelated: true };
  await writeFile(join(root, "model.config.json"), JSON.stringify(config));
  await writeFile(join(root, "package.json"), JSON.stringify(pkg));
  await mkdir(join(root, "node_modules", "stockfish"), { recursive: true });
  await writeFile(join(root, "node_modules", "stockfish", "package.json"), JSON.stringify({ version: "18.0.8", buildVersion: "18" }));
  return { root, config };
}

async function pin(root: string) {
  const path = join(root, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8"));
  pkg.dependencies.stockfish = "18.0.8";
  await writeFile(path, JSON.stringify(pkg));
}

test("Stockfish preparation pins the dependency and records defaults only after probing", async () => {
  const { root, config } = await fixture();
  try {
    const commands: string[][] = [];
    const result = await prepareStockfish({
      root,
      run: async (args: string[], cwd: string) => {
        assert.equal(cwd, root);
        commands.push(args);
        if (args[0] === "add") await pin(root);
      },
      probe: async (cwd: string, flavor: string) => {
        assert.equal(cwd, root);
        assert.equal(flavor, "full");
        const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
        assert.equal(pkg.stockfish.flavor, "lite-single");
      },
    });
    assert.deepEqual(commands, [["add", "--save-exact", "--ignore-scripts", "stockfish@18.0.8"], ["exec", "tsc"]]);
    assert.equal(result.engineVersion, "18");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.stockfish.flavor, "full");
    assert.equal(pkg.unrelated, true);
    assert.equal(pkg.version, "0.7.2");
    await checkStockfishConfig({ root, config: config.stockfish });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed Stockfish preparation preserves old defaults and reports dependency changes", async () => {
  const { root } = await fixture();
  try {
    await assert.rejects(prepareStockfish({ root, run: async () => pin(root), probe: async () => { throw new Error("incompatible API"); } }), /Dependency files may have changed/);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.dependencies.stockfish, "18.0.8");
    assert.equal(pkg.stockfish.flavor, "lite-single");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stockfish config rejects ranges, tags, prereleases, and unknown flavors", () => {
  for (const version of ["18", "^18.0.8", "latest", "18.0.8-beta.1", "018.0.8", "18.0.8\n"]) {
    assert.throws(() => validateStockfishConfig({ version, flavor: "full" }), /invalid stockfish config/);
  }
  assert.throws(() => validateStockfishConfig({ version: "18.0.8", flavor: "unknown" }), /invalid stockfish config/);
});

test("Stockfish preparation rejects invalid config before changing dependencies", async () => {
  const { root, config } = await fixture();
  try {
    const packageBefore = await readFile(join(root, "package.json"), "utf8");
    await writeFile(join(root, "model.config.json"), JSON.stringify({ ...config, maia3: { ...config.maia3, model: "invalid" } }));
    await assert.rejects(prepareStockfish({ root, run: async () => assert.fail("must not install") }), /unsupported config\.maia3\.model/);
    assert.equal(await readFile(join(root, "package.json"), "utf8"), packageBefore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stockfish preparation does not record defaults if config changes while probing", async () => {
  const { root, config } = await fixture();
  try {
    await assert.rejects(prepareStockfish({
      root,
      run: async () => {},
      probe: async () => {
        await writeFile(join(root, "model.config.json"), JSON.stringify({ ...config, stockfish: { ...config.stockfish, flavor: "single" } }));
      },
    }), (error: unknown) => error instanceof Error && error.cause instanceof Error && /configuration changed/.test(error.cause.message));
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(pkg.stockfish.flavor, "lite-single");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stockfish checks reject installed version and metadata drift", async () => {
  const { root, config } = await fixture();
  try {
    await assert.rejects(checkStockfishConfig({ root, config: config.stockfish }), /dependency does not match/);
    await pin(root);
    await assert.rejects(checkStockfishConfig({ root, config: config.stockfish }), /default flavor does not match/);
    const path = join(root, "package.json");
    const pkg = JSON.parse(await readFile(path, "utf8"));
    pkg.stockfish = { flavor: "full" };
    await writeFile(path, JSON.stringify(pkg));
    await writeFile(join(root, "node_modules", "stockfish", "package.json"), JSON.stringify({ version: "17.0.0" }));
    await assert.rejects(checkStockfishConfig({ root, config: config.stockfish }), /installed version/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stockfish probe rejects bad engine APIs and empty analysis", async () => {
  const { root } = await fixture();
  try {
    await mkdir(join(root, "dist", "engines"), { recursive: true });
    const path = join(root, "dist", "engines", "stockfish.js");
    await writeFile(path, "export const Stockfish = undefined;");
    await assert.rejects(probeStockfish(root, "full"), /not a constructor/);
    await writeFile(path, "export class Stockfish { async analyze() { return []; } async quit() {} }");
    await assert.rejects(probeStockfish(root, "full"), /returned no analysis/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
