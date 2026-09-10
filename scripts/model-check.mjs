import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_KEYS = new Set(["3m", "5m", "23m", "79m"]);
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;

function fail(message) {
  throw new Error(`model check failed: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  if (value.includes("\0")) fail(`${label} contains a NUL byte`);
  return value;
}

function safeRelativePath(value, label) {
  const path = string(value, label);
  if (isAbsolute(path) || path.includes("\\") || path.includes(":")) fail(`${label} must be a safe relative POSIX path`);
  if (path.split("/").some((part) => part.length === 0 || part === "." || part === "..")) fail(`${label} must be a normalized relative path`);
  return path;
}

function assertSource(source) {
  object(source, "config.source");
  string(source.type, "config.source.type");
  if (source.type === "huggingface") {
    if (!isDeepStrictEqual(Object.keys(source).sort(), ["filename", "repoId", "revision", "type"])) fail("config.source has invalid fields");
    string(source.repoId, "config.source.repoId");
    string(source.filename, "config.source.filename");
    string(source.revision, "config.source.revision");
    if (!REVISION.test(source.revision)) fail("config.source.revision must be a lowercase 40-character commit SHA");
    return;
  }
  if (source.type === "local") {
    if (!isDeepStrictEqual(Object.keys(source).sort(), ["path", "type"])) fail("config.source has invalid fields");
    const path = string(source.path, "config.source.path");
    if (path.includes("\0")) fail("config.source.path contains a NUL byte");
    return;
  }
  fail(`unsupported config.source.type: ${source.type}`);
}

export function validateModelConfig(config) {
  object(config, "model.config.json");
  if (!isDeepStrictEqual(Object.keys(config).sort(), ["model", "schemaVersion", "source"])) fail("config has invalid fields");
  if (config.schemaVersion !== 1) fail("config.schemaVersion must be 1");
  string(config.model, "config.model");
  if (!MODEL_KEYS.has(config.model)) fail(`unsupported config.model: ${config.model}`);
  assertSource(config.source);
  return config;
}

export function validateModelManifest(manifest) {
  object(manifest, "models/manifest.json");
  if (manifest.schemaVersion !== 1) fail("manifest.schemaVersion must be 1");
  string(manifest.model, "manifest.model");
  if (!MODEL_KEYS.has(manifest.model)) fail(`unsupported manifest.model: ${manifest.model}`);
  object(manifest.config, "manifest.config");
  string(manifest.checkpointSha256, "manifest.checkpointSha256");
  if (!SHA256.test(manifest.checkpointSha256)) fail("manifest.checkpointSha256 must be a SHA-256 digest");
  const modelFile = safeRelativePath(manifest.modelFile, "manifest.modelFile");
  if (extname(modelFile) !== ".onnx") fail("manifest.modelFile must be an .onnx file");
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("manifest.files must be a non-empty array");
  const files = new Map();
  for (const [index, entry] of manifest.files.entries()) {
    object(entry, `manifest.files[${index}]`);
    const path = safeRelativePath(entry.path, `manifest.files[${index}].path`);
    if (files.has(path)) fail(`manifest.files contains duplicate path: ${path}`);
    string(entry.sha256, `manifest.files[${index}].sha256`);
    if (!SHA256.test(entry.sha256)) fail(`manifest.files[${index}].sha256 must be a SHA-256 digest`);
    files.set(path, entry.sha256.toLowerCase());
  }
  if (!files.has(modelFile)) fail("manifest.modelFile is not listed in manifest.files");
  return { ...manifest, modelFile, files };
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

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function checkModelBundle({ configPath = join(ROOT, "model.config.json"), modelsDir = join(ROOT, "models") } = {}) {
  const config = validateModelConfig(JSON.parse(await readFile(configPath, "utf8")));
  const manifestPath = join(modelsDir, "manifest.json");
  const manifest = validateModelManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  if (manifest.model !== config.model) fail("manifest.model does not match config.model");
  validateModelConfig(manifest.config);
  if (!isDeepStrictEqual(manifest.config, config)) fail("manifest.config does not match model.config.json");

  const listed = new Set(manifest.files.keys());
  const actual = await walk(modelsDir);
  for (const path of actual) {
    const relativePath = path.slice(modelsDir.length + 1).replaceAll(sep, "/");
    if (relativePath !== "manifest.json" && !listed.has(relativePath)) fail(`unlisted model artifact: models/${relativePath}`);
  }
  for (const path of listed) {
    const expected = manifest.files.get(path);
    const fullPath = resolve(modelsDir, path);
    const manifestRelative = relative(resolve(modelsDir), fullPath);
    if (manifestRelative === "" || manifestRelative === ".." || manifestRelative.startsWith(`..${sep}`) || isAbsolute(manifestRelative)) fail(`manifest path escapes models directory: ${path}`);
    const info = await lstat(fullPath).catch(() => null);
    if (!info?.isFile()) fail(`manifest file is missing: models/${path}`);
    const actualDigest = await digest(fullPath);
    if (actualDigest !== expected) fail(`SHA-256 mismatch for models/${path}`);
  }
  return { model: manifest.model, modelFile: resolve(modelsDir, manifest.modelFile), files: [...listed] };
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log("Usage: node scripts/model-check.mjs [--config path] [--models path]");
      process.exit(0);
    }
    if (argument !== "--config" && argument !== "--models") fail(`unknown option: ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${argument} requires a path`);
    options[argument.slice(2)] = resolve(value);
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await checkModelBundle({ configPath: options.config, modelsDir: options.models });
    console.log(`model check passed: ${result.model} (${result.files.length} files)`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
