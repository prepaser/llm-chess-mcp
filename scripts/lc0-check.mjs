import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHA256 = /^[0-9a-f]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const CONFIG_BACKENDS = new Set(["cpu", "cuda"]);
const MANIFEST_BACKENDS = new Set(["blas", "dnnl", "cuda", "cuda-fp16", "cuda-auto"]);
const PLATFORMS = new Set(["linux-x64", "win32-x64"]);

function fail(message) {
  throw new Error(`Lc0 bundle check failed: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function checksum(value, label) {
  const result = string(value, label);
  if (result.trim() !== result || !SHA256.test(result)) fail(`${label} must be a SHA-256 digest`);
  return result;
}

function safePath(value, label) {
  const path = string(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.includes(":")) {
    fail(`${label} must be a safe relative POSIX path`);
  }
  const parts = path.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${label} must be a normalized relative path`);
  }
  return path;
}

function keys(value, expected, label) {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail(`${label} has invalid fields`);
  }
}

export function validateLc0Config(config) {
  object(config, "config.lc0");
  keys(config, ["version", "weights", "backend", "platforms"], "config.lc0");
  string(config.version, "config.lc0.version");
  if (config.version.trim() !== config.version || !VERSION.test(config.version)) fail("config.lc0.version must be an exact stable version");
  string(config.backend, "config.lc0.backend");
  if (!CONFIG_BACKENDS.has(config.backend)) fail(`unsupported config.lc0.backend: ${config.backend}`);
  if (!Array.isArray(config.platforms) || config.platforms.length === 0 ||
      new Set(config.platforms).size !== config.platforms.length ||
      config.platforms.some((platform) => typeof platform !== "string" || !PLATFORMS.has(platform))) {
    fail("config.lc0.platforms must contain unique supported platforms");
  }
  object(config.weights, "config.lc0.weights");
  keys(config.weights, ["url", "sha256"], "config.lc0.weights");
  const url = string(config.weights.url, "config.lc0.weights.url");
  if (url.trim() !== url || !url.startsWith("https://")) fail("config.lc0.weights.url must be HTTPS");
  const weightChecksum = checksum(config.weights.sha256, "config.lc0.weights.sha256");
  return {
    version: config.version,
    backend: config.backend,
    platforms: [...config.platforms],
    weights: { url, sha256: weightChecksum },
  };
}

function fileEntries(entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) fail(`${label} must be a non-empty array`);
  const files = new Map();
  for (const [index, entry] of entries.entries()) {
    object(entry, `${label}[${index}]`);
    keys(entry, ["path", "sha256"], `${label}[${index}]`);
    const path = safePath(entry.path, `${label}[${index}].path`);
    const digestValue = checksum(entry.sha256, `${label}[${index}].sha256`);
    if (files.has(path)) fail(`${label} contains duplicate path: ${path}`);
    files.set(path, digestValue);
  }
  return files;
}

export function validateLc0Manifest(manifest) {
  object(manifest, "lc0/manifest.json");
  keys(manifest, ["schemaVersion", "engineVersion", "weights", "platforms"], "lc0 manifest");
  if (manifest.schemaVersion !== 1) fail("lc0 manifest.schemaVersion must be 1");
  string(manifest.engineVersion, "lc0 manifest.engineVersion");
  if (manifest.engineVersion.trim() !== manifest.engineVersion || !VERSION.test(manifest.engineVersion)) fail("lc0 manifest.engineVersion must be an exact version");
  object(manifest.weights, "lc0 manifest.weights");
  keys(manifest.weights, ["path", "sha256"], "lc0 manifest.weights");
  const weightPath = safePath(manifest.weights.path, "lc0 manifest.weights.path");
  const weightDigest = checksum(manifest.weights.sha256, "lc0 manifest.weights.sha256");
  object(manifest.platforms, "lc0 manifest.platforms");
  const platforms = new Map();
  for (const [platform, value] of Object.entries(manifest.platforms)) {
    if (!PLATFORMS.has(platform)) fail(`unsupported lc0 manifest platform: ${platform}`);
    object(value, `lc0 manifest.platforms.${platform}`);
    keys(value, ["executable", "backend", "files"], `lc0 manifest.platforms.${platform}`);
    const executable = safePath(value.executable, `lc0 manifest.platforms.${platform}.executable`);
    string(value.backend, `lc0 manifest.platforms.${platform}.backend`);
    if (!MANIFEST_BACKENDS.has(value.backend)) fail(`unsupported backend for ${platform}: ${value.backend}`);
    const files = fileEntries(value.files, `lc0 manifest.platforms.${platform}.files`);
    if (!files.has(executable)) fail(`${platform} executable is not listed in files`);
    platforms.set(platform, { executable, backend: value.backend, files });
  }
  if (platforms.size === 0) fail("lc0 manifest.platforms must not be empty");
  return { engineVersion: manifest.engineVersion, weights: { path: weightPath, sha256: weightDigest }, platforms };
}

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function walk(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(path));
    else if (entry.isFile()) result.push(path);
    else if (entry.isSymbolicLink()) fail(`symbolic links are not allowed: ${path}`);
  }
  return result;
}

async function checkFiles(root, entries, listed) {
  for (const [path, expected] of entries) {
    listed.add(path);
    const full = resolve(root, path);
    const relativePath = relative(root, full);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      fail(`manifest path escapes lc0 directory: ${path}`);
    }
    const info = await lstat(full).catch(() => null);
    if (!info?.isFile()) fail(`manifest file is missing: lc0/${path}`);
    if (await digest(full) !== expected) fail(`SHA-256 mismatch for lc0/${path}`);
  }
}

export async function checkLc0Bundle({ config, lc0Dir = join(ROOT, "bundle", "lc0") } = {}) {
  const normalizedConfig = validateLc0Config(config);
  const manifest = validateLc0Manifest(JSON.parse(await readFile(join(lc0Dir, "manifest.json"), "utf8")));
  if (manifest.engineVersion !== normalizedConfig.version) fail("engine version does not match config");
  if (manifest.weights.sha256 !== normalizedConfig.weights.sha256) fail("weights SHA-256 does not match config");
  if (manifest.platforms.size !== normalizedConfig.platforms.length) fail("manifest platforms do not match config");
  for (const platform of normalizedConfig.platforms) {
    const entry = manifest.platforms.get(platform);
    if (!entry) fail(`manifest is missing configured platform: ${platform}`);
    const allowedBackends = normalizedConfig.backend === "cpu"
      ? new Set(["blas", "dnnl"])
      : new Set(["cuda", "cuda-fp16", "cuda-auto"]);
    if (!allowedBackends.has(entry.backend)) fail(`${platform} backend does not match config`);
  }
  const listed = new Set(["manifest.json"]);
  await checkFiles(lc0Dir, new Map([[manifest.weights.path, manifest.weights.sha256]]), listed);
  for (const entry of manifest.platforms.values()) await checkFiles(lc0Dir, entry.files, listed);
  for (const path of await walk(lc0Dir)) {
    const relativePath = relative(lc0Dir, path).replaceAll(sep, "/");
    if (!listed.has(relativePath)) fail(`unlisted Lc0 artifact: lc0/${relativePath}`);
  }
  return { version: manifest.engineVersion, platforms: [...manifest.platforms.keys()], weights: manifest.weights.path };
}
