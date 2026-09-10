import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { validateLc0Config, checkLc0Bundle } from "./lc0-check.mjs";
import { validateBuildConfig } from "./model-check.mjs";
export { validateLc0Config } from "./lc0-check.mjs";

const exec = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_VERSION = "0.32.1";
const WINDOWS_RELEASE_BASE = "https://github.com/LeelaChessZero/lc0/releases/download";
const WINDOWS_ASSET = (version) => `lc0-v${version}-windows-cpu-dnnl.zip`;
const WINDOWS_ASSET_SHA256 = "b9cfcfbd3dabffbfd452f6e8e087c22273721bef48eba19640b6d92006c142f5";
const PLATFORM_KEYS = new Set(["linux-x64", "win32-x64"]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message) { throw new Error(message); }

function string(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) fail(`${label} must be a non-empty string`);
  return value;
}

export function platformKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch === "x64" ? "x64" : arch}`;
  if (!PLATFORM_KEYS.has(key)) fail(`unsupported Lc0 platform: ${key}`);
  return key;
}

export async function sha256(path) {
  const hash = createHash("sha256");
  await pipeline((await import("node:fs")).createReadStream(path), hash);
  return hash.digest("hex");
}

function safeRelative(path, label) {
  string(path, label);
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized === "." || normalized.split("/").includes("..") || normalized.split("/").includes("")) {
    fail(`${label} must be a safe relative path`);
  }
  return normalized;
}

async function download(url, destination, expectedSha256) {
  const temporary = `${destination}.${randomUUID()}.part`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(300_000) });
    if (!response.ok || !response.body) fail(`download failed (${response.status}) for ${url}`);
    await pipeline(response.body, createWriteStream(temporary, { flags: "wx" }));
    const actual = await sha256(temporary);
    if (actual !== expectedSha256) fail(`SHA-256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function command(file, args, options = {}) {
  await exec(file, args, { timeout: 900_000, maxBuffer: 16 * 1024 * 1024, ...options });
}

async function buildLinux({ version, directory, run = command }) {
  await cp(new URL("./lc0-linux-build.sh", import.meta.url), join(directory, "build.sh"));
  const args = ["run", "--rm", "--cpus=2", "--memory=6g", "--mount", `type=bind,source=${directory},target=/work`,
    "--env", `LC0_OUTPUT_UID=${process.getuid?.() ?? 0}`, "--env", `LC0_OUTPUT_GID=${process.getgid?.() ?? 0}`,
    "ubuntu:22.04", "bash", "/work/build.sh", version];
  if (process.env.LC0_DOCKER_SUDO === "1") await run("sudo", ["-n", "docker", ...args]);
  else await run("docker", args);
  const executable = join(directory, "artifact", "lc0");
  await stat(executable);
  return executable;
}

async function extractWindows(archive, directory, run = command) {
  const extracted = join(directory, "windows");
  await mkdir(extracted, { recursive: true });
  await run("unzip", ["-q", archive, "-d", extracted]);
  const entries = await readdir(extracted);
  for (const name of ["lc0.exe"]) {
    if (!entries.includes(name)) fail(`Windows Lc0 archive is missing ${name}`);
  }
  return extracted;
}

async function windowsAssetDigest(version) {
  if (version === DEFAULT_VERSION) return WINDOWS_ASSET_SHA256;
  const response = await fetch(`https://api.github.com/repos/LeelaChessZero/lc0/releases/tags/v${version}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "llm-chess-mcp-lc0-prepare" },
  });
  if (!response.ok) fail(`could not resolve the official Lc0 ${version} release (${response.status})`);
  const release = await response.json();
  const asset = release.assets?.find((candidate) => candidate.name === WINDOWS_ASSET(version));
  const value = asset?.digest;
  if (typeof value !== "string" || !value.startsWith("sha256:") || !SHA256.test(value.slice(7))) {
    fail(`official Lc0 ${version} release has no SHA-256 for ${WINDOWS_ASSET(version)}`);
  }
  return value.slice(7);
}

function spawnProbe(executable, args, { cwd, expectedVersion, timeoutMs = 30_000, spawnImpl = spawn } = {}) {
  return new Promise((resolveProbe, rejectProbe) => {
    const child = spawnImpl(executable, args, {
      cwd, stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, OMP_NUM_THREADS: "2", OPENBLAS_NUM_THREADS: "2", MKL_NUM_THREADS: "2", WINEDEBUG: "-all" },
    });
    let output = "";
    let errorOutput = "";
    let settled = false;
    let readySent = false;
    let goSent = false;
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Lc0 UCI probe timed out")); }, timeoutMs);
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectProbe(error);
      else resolveProbe(value);
    };
    let quitSent = false;
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > 1_048_576) { child.kill("SIGKILL"); finish(new Error("Lc0 probe output exceeded limit")); return; }
      if (!quitSent && output.includes("bestmove")) {
        quitSent = true;
        child.stdin.write("quit\n");
      } else if (!goSent && output.includes("readyok")) {
        goSent = true;
        child.stdin.write("position startpos\ngo movetime 100\n");
      } else if (!readySent && output.includes("uciok")) {
        readySent = true;
        child.stdin.write("isready\n");
      }
    });
    child.stderr?.on("data", (chunk) => { errorOutput = (errorOutput + chunk).slice(-65_536); });
    child.stdin?.once?.("error", (error) => { child.kill("SIGKILL"); finish(error); });
    child.once("error", (error) => finish(error));
    child.once("exit", (code, signal) => {
      if (code !== 0) finish(new Error(`Lc0 UCI probe exited with ${code ?? signal}: ${errorOutput.trim()}`));
      else if (!output.includes("uciok") || !output.includes("readyok") || !output.includes("bestmove") || !/^info .*\bscore (?:cp -?\d+|mate -?\d+)\b.*\bpv\s+\S+/m.test(output)) finish(new Error("Lc0 UCI probe did not complete handshake and scored analysis"));
      else if (expectedVersion && !new RegExp(`^id name .*\\bv${expectedVersion.replaceAll(".", "\\.")}(?:\\s|$)`, "m").test(output)) finish(new Error(`Lc0 UCI probe version does not match ${expectedVersion}`));
      else finish(undefined, output);
    });
    child.stdin.write("uci\n");
  });
}

export async function probeLc0({ executable, weights, backend = "cpu", version, cwd, spawnImpl } = {}) {
  const backendName = backend === "cpu" ? "blas" : backend;
  const windows = executable.toLowerCase().endsWith(".exe");
  const launcher = windows && process.platform !== "win32" ? "wine" : executable;
  const args = windows && process.platform !== "win32"
    ? [executable, `--weights=${weights}`, `--backend=${backendName}`, "--config=", "--threads=2", "--minibatch-size=16"]
    : [`--weights=${weights}`, `--backend=${backendName}`, "--config=", "--threads=2", "--minibatch-size=16"];
  return spawnProbe(launcher, args, { cwd, expectedVersion: version, spawnImpl });
}

function backendFor(platform, backend) {
  if (backend !== "cpu") return "cuda-auto";
  return "blas";
}

async function copyFiles(sourceDir, destinationDir, names) {
  await mkdir(destinationDir, { recursive: true });
  for (const name of names) await cp(join(sourceDir, name), join(destinationDir, name));
}

async function copyTree(sourceDir, destinationDir, { exclude = () => false } = {}) {
  const files = [];
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      const source = join(current, entry.name);
      if (entry.isDirectory()) await visit(source, name);
      else if (entry.isFile() && !exclude(name)) {
        const target = join(destinationDir, name);
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { dereference: true });
        files.push(name);
      } else if (entry.isSymbolicLink()) fail(`symbolic links are not allowed in external Lc0 bundle: ${name}`);
    }
  }
  await visit(sourceDir);
  return files;
}

async function installBundle(staging, outputDir) {
  const backup = `${outputDir}.backup-${randomUUID()}`;
  let backedUp = false;
  try {
    await rename(outputDir, backup).then(() => { backedUp = true; }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(staging, outputDir);
  } catch (error) {
    if (backedUp) {
      try { await rename(backup, outputDir); }
      catch (restoreError) { throw new AggregateError([error, restoreError], `Lc0 bundle restore failed; previous bundle remains at ${backup}`); }
    }
    throw error;
  }
  if (backedUp) await rm(backup, { recursive: true, force: true }).catch(() => {
    console.error(`Lc0 bundle installed; old backup could not be removed: ${backup}`);
  });
}

async function manifestFor(staging, config, weightPath, platforms) {
  for (const [key, item] of Object.entries(platforms)) {
    const listed = [];
    for (const file of item.files) {
      const path = safeRelative(file.path, `${key}.files.path`);
      const full = resolve(staging, path);
      if (resolve(full) !== full || relative(staging, full).startsWith(`..${sep}`)) fail(`Lc0 artifact escapes staging: ${path}`);
      listed.push({ path, sha256: await sha256(full) });
    }
    item.files = listed;
  }
  const weightRelative = safeRelative(relative(staging, weightPath).replaceAll(sep, "/"), "weights.path");
  return {
    schemaVersion: 1,
    engineVersion: config.version,
    weights: { path: weightRelative, sha256: await sha256(weightPath) },
    platforms,
  };
}

export async function prepareLc0({ root = ROOT, config, outputDir = join(root, "bundle", "lc0"), platforms = config?.platforms, downloadImpl = download, buildImpl = buildLinux, extractImpl = extractWindows, probeImpl = probeLc0, commandImpl = command } = {}) {
  root = resolve(root);
  outputDir = resolve(outputDir);
  const outputRelative = relative(root, outputDir);
  if (!outputRelative || outputRelative === ".." || outputRelative.startsWith(`..${sep}`)) fail("Lc0 output must be inside the project directory");
  const configPath = join(root, "model.config.json");
  const configContents = config === undefined ? await readFile(configPath, "utf8") : undefined;
  if (configContents !== undefined) config = validateBuildConfig(JSON.parse(configContents)).lc0;
  config = validateLc0Config(config);
  const selected = [...(platforms ?? config.platforms)];
  if (!selected.length || new Set(selected).size !== selected.length || !selected.every((key) => config.platforms.includes(key))) fail("requested Lc0 platform is not enabled by config");
  if (selected.length !== config.platforms.length) fail("all configured Lc0 platforms must be prepared together");
  const work = join(root, `.lc0-prepare-${randomUUID()}`);
  const staging = join(work, "bundle", "lc0");
  await mkdir(staging, { recursive: true });
  try {
    const weightName = "network.pb.gz";
    const weightPath = join(staging, "weights", weightName);
    await downloadImpl(config.weights.url, weightPath, config.weights.sha256);
    const platformManifest = {};
    for (const key of selected) {
      const platformWork = join(work, key);
      await mkdir(platformWork, { recursive: true });
      const target = join(staging, key);
      if (key === "linux-x64") {
        const external = process.env.LC0_LINUX_BUNDLE;
        if (config.backend !== "cpu" && !external) fail(`Lc0 ${config.backend} preparation requires LC0_LINUX_BUNDLE`);
        const built = external
          ? join(platformWork, "external", "lc0")
          : await buildImpl({ version: config.version, directory: platformWork, run: commandImpl });
        if (external) {
          await copyTree(external, join(platformWork, "external"));
          await stat(built);
        }
        const files = (await copyTree(dirname(built), target)).map((path) => `linux-x64/${path}`);
        await probeImpl({ executable: join(target, "lc0"), weights: weightPath, backend: backendFor(key, config.backend), version: config.version, cwd: target });
        platformManifest[key] = { executable: "linux-x64/lc0", backend: backendFor(key, config.backend), files: files.map((path) => ({ path })) };
      } else if (key === "win32-x64") {
        const archive = join(platformWork, WINDOWS_ASSET(config.version));
        const external = config.backend !== "cpu" ? process.env.LC0_WINDOWS_ARCHIVE : null;
        if (config.backend !== "cpu" && !external) fail(`Lc0 ${config.backend} preparation requires LC0_WINDOWS_ARCHIVE`);
        const url = external ? pathToFileURL(resolve(external)).href : `${WINDOWS_RELEASE_BASE}/v${config.version}/${WINDOWS_ASSET(config.version)}`;
        const expected = external ? process.env.LC0_WINDOWS_ARCHIVE_SHA256 : await windowsAssetDigest(config.version);
        if (!expected || !SHA256.test(expected)) fail(`Lc0 ${config.backend} preparation requires LC0_WINDOWS_ARCHIVE_SHA256`);
        if (external) {
          await cp(resolve(external), archive);
          if (await sha256(archive) !== expected) fail("SHA-256 mismatch for LC0_WINDOWS_ARCHIVE");
        } else await downloadImpl(url, archive, expected);
        const extracted = await extractImpl(archive, platformWork, commandImpl);
        const names = config.backend !== "cpu"
          ? await copyTree(extracted, target, { exclude: (name) => name.toLowerCase().endsWith(".pb.gz") })
          : ["lc0.exe", "dnnl.dll", "mimalloc-override.dll", "mimalloc-redirect.dll"];
        if (config.backend === "cpu") await copyFiles(extracted, target, names);
        const notices = await copyTree(extracted, target, {
          exclude: (name) => !/(?:license|copying|notice|readme|authors)/i.test(name),
        });
        for (const name of notices) if (!names.includes(name)) names.push(name);
        await writeFile(join(target, "BUNDLE-SOURCES.json"), JSON.stringify({
          engineVersion: config.version,
          engineSource: `https://github.com/LeelaChessZero/lc0/tree/v${config.version}`,
          archiveSha256: expected,
          archive: external ? "publisher-provided" : url,
          provider: config.backend === "cpu" ? "DNNL" : "publisher-provided CUDA runtime",
        }, null, 2) + "\n");
        names.push("BUNDLE-SOURCES.json");
        if (!names.includes("lc0.exe")) fail("external Windows Lc0 bundle is missing lc0.exe");
        const files = names.map((name) => `win32-x64/${name}`);
        await probeImpl({ executable: join(target, "lc0.exe"), weights: weightPath, backend: backendFor(key, config.backend), version: config.version, cwd: target });
        platformManifest[key] = { executable: "win32-x64/lc0.exe", backend: backendFor(key, config.backend), files: files.map((path) => ({ path })) };
      }
    }
    const manifest = await manifestFor(staging, config, weightPath, platformManifest);
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await checkLc0Bundle({ config, lc0Dir: staging });
    await mkdir(dirname(outputDir), { recursive: true });
    if (configContents !== undefined && await readFile(configPath, "utf8") !== configContents) {
      fail("model configuration changed during preparation; retry");
    }
    await installBundle(staging, outputDir);
    return manifest;
  } catch (error) {
    throw new Error("Lc0 preparation failed; the existing bundle was preserved", { cause: error });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {
      console.error(`Lc0 preparation temporary files remain at ${work}`);
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const manifest = await prepareLc0({ root: ROOT });
    console.log(`Lc0 ${manifest.engineVersion} ready for ${Object.keys(manifest.platforms).join(", ")}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
