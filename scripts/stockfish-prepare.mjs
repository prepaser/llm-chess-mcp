import { execFile } from "node:child_process";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { installedStockfish, validateStockfishConfig } from "./stockfish-config.mjs";
import { validateBuildConfig } from "./model-check.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = promisify(execFile);

async function updatePackage(root, update) {
  const packagePath = join(root, "package.json");
  const pkg = JSON.parse(await readFile(packagePath, "utf8"));
  update(pkg);
  const temporary = join(root, `.stockfish-package-${randomUUID()}.json`);
  try {
    await writeFile(temporary, JSON.stringify(pkg, null, 2) + "\n", { flag: "wx" });
    await rename(temporary, packagePath);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function runPnpm(args, root) {
  const executable = process.env.npm_execpath;
  const invocation = executable && /pnpm\.(?:c?js|mjs)$/i.test(executable)
    ? [process.execPath, [executable, ...args]]
    : ["pnpm", args];
  await exec(...invocation, { cwd: root, timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
}

export async function probeStockfish(root, flavor) {
  await exec(process.execPath, [fileURLToPath(new URL("./stockfish-probe.mjs", import.meta.url)), root, flavor], {
    cwd: root, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
}

export async function prepareStockfish({ root = ROOT, run = runPnpm, probe = probeStockfish } = {}) {
  const configPath = join(root, "model.config.json");
  const contents = await readFile(configPath, "utf8");
  const config = JSON.parse(contents);
  validateBuildConfig(config);
  const { version, flavor } = validateStockfishConfig(config.stockfish);
  try {
    await updatePackage(root, (pkg) => {
      if (!pkg.dependencies || typeof pkg.dependencies !== "object" || Array.isArray(pkg.dependencies)) {
        throw new Error("package dependencies are missing");
      }
      pkg.dependencies.stockfish = version;
    });
    await run(["add", "--save-exact", "--ignore-scripts", `stockfish@${version}`], root);
    const installed = await installedStockfish(root);
    if (installed.version !== version) throw new Error(`installed Stockfish version does not match ${version}`);
    await run(["exec", "tsc"], root);
    await probe(root, flavor);
    if (await readFile(configPath, "utf8") !== contents) throw new Error("model configuration changed during preparation; retry");
    await updatePackage(root, (pkg) => {
      if (pkg.dependencies?.stockfish !== version) throw new Error("Stockfish dependency was not pinned to the requested version");
      pkg.stockfish = { flavor };
    });
    return { version, flavor, engineVersion: installed.buildVersion };
  } catch (error) {
    throw new Error("Stockfish preparation failed. Dependency files may have changed; fix the config or compatibility error and rerun pnpm stockfish:prepare. No Git changes were reverted.", { cause: error });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await prepareStockfish();
    console.log(`Stockfish ready: npm ${result.version}, engine ${result.engineVersion ?? "unknown"}, ${result.flavor}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
