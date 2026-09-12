import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const MODEL_KEYS = ["3m", "5m", "23m", "79m"] as const;
export type Maia3ModelKey = (typeof MODEL_KEYS)[number];

type HuggingFaceSource = {
  type: "huggingface";
  repoId: string;
  filename: string;
  revision: string;
};

type LocalSource = { type: "local"; path: string };

export type Maia3ModelSource = HuggingFaceSource | LocalSource;

export type Maia3ModelConfig = {
  schemaVersion: 1;
  model: Maia3ModelKey;
  source: Maia3ModelSource;
};

export type Maia3ManifestFile = { path: string; sha256: string };

export type Maia3Manifest = {
  schemaVersion: 1;
  model: Maia3ModelKey;
  config: Maia3ModelConfig;
  checkpointSha256: string;
  files: Maia3ManifestFile[];
  modelFile: string;
};

export type ResolveModelPathOptions = {
  packageModelsDir?: string;
  cwd?: string;
  modelKey?: string;
};

const MANIFEST_FILE = "manifest.json";
const SHA256 = /^[a-f0-9]{64}$/i;
const here = dirname(fileURLToPath(import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isModelKey(value: unknown): value is Maia3ModelKey {
  return typeof value === "string" && (MODEL_KEYS as readonly string[]).includes(value);
}

function invalidManifest(message: string): Error {
  return new Error(`invalid Maia3 model manifest: ${message}`);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function sourceString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function parseSource(value: unknown): Maia3ModelSource {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw invalidManifest("invalid model source");
  }
  if (value.type === "huggingface") {
    if (
      !sourceString(value.repoId) ||
      !sourceString(value.filename) ||
      !sourceString(value.revision) ||
      !/^[0-9a-f]{40}$/i.test(value.revision)
    ) {
      throw invalidManifest("invalid Hugging Face source");
    }
    return {
      type: "huggingface",
      repoId: value.repoId,
      filename: value.filename,
      revision: value.revision,
    };
  }
  if (value.type === "local" && sourceString(value.path)) {
    return { type: "local", path: value.path };
  }
  throw invalidManifest("unsupported model source");
}

function safeRelativePath(value: unknown, field: string): string {
  if (
    !nonEmptyString(value) ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.includes(":") ||
    isAbsolute(value) ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw invalidManifest(`${field} must be a safe relative path`);
  }
  return value;
}

function inside(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== "" && !child.startsWith(`..${sep}`) && child !== ".." && !isAbsolute(child);
}

function existingModelFile(modelsDir: string, path: string): string {
  let root: string;
  let candidate: string;
  let realCandidate: string;
  try {
    root = realpathSync(modelsDir);
    candidate = resolve(modelsDir, path);
    if (!inside(resolve(modelsDir), candidate)) {
      throw invalidManifest(`file path escapes models directory: ${path}`);
    }
    realCandidate = realpathSync(candidate);
    if (!statSync(realCandidate).isFile()) {
      throw new Error(`Maia3 model file is not a regular file: ${path}`);
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message.startsWith("invalid Maia3 model manifest:") ||
        error.message.startsWith("Maia3 model file is not a regular file:"))
    ) {
      throw error;
    }
    throw new Error(`Maia3 model file not found: ${path}`);
  }
  if (!inside(root, realCandidate)) {
    throw invalidManifest(`file path escapes models directory: ${path}`);
  }
  return candidate;
}

function parseManifest(value: unknown): Maia3Manifest {
  if (!isRecord(value)) throw invalidManifest("manifest must be an object");
  if (value.schemaVersion !== 1) throw invalidManifest("unsupported schema version");
  if (!isModelKey(value.model)) throw invalidManifest("unsupported model");
  if (!isRecord(value.config) || value.config.schemaVersion !== 1) {
    throw invalidManifest("invalid model config");
  }
  if (value.config.model !== value.model) {
    throw invalidManifest("manifest and config model differ");
  }
  const source = parseSource(value.config.source);
  if (typeof value.checkpointSha256 !== "string" || !SHA256.test(value.checkpointSha256)) {
    throw invalidManifest("invalid checkpoint SHA-256");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw invalidManifest("manifest files must be non-empty");
  }
  const files: Maia3ManifestFile[] = [];
  const paths = new Set<string>();
  for (const entry of value.files) {
    if (!isRecord(entry)) throw invalidManifest("invalid model file entry");
    const path = safeRelativePath(entry.path, "file path");
    if (paths.has(path)) throw invalidManifest(`duplicate file path: ${path}`);
    if (typeof entry.sha256 !== "string" || !SHA256.test(entry.sha256)) {
      throw invalidManifest(`invalid SHA-256 for ${path}`);
    }
    paths.add(path);
    files.push({ path, sha256: entry.sha256 });
  }
  const modelFile = safeRelativePath(value.modelFile, "modelFile");
  if (!modelFile.endsWith(".onnx")) throw invalidManifest("modelFile must be an .onnx file");
  if (!paths.has(modelFile)) throw invalidManifest("modelFile is not listed in files");
  return {
    schemaVersion: 1,
    model: value.model,
    config: { schemaVersion: 1, model: value.model, source },
    checkpointSha256: value.checkpointSha256,
    files,
    modelFile,
  };
}

export function readManifest(modelsDir: string): Maia3Manifest {
  const path = join(modelsDir, MANIFEST_FILE);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new Error(`Maia3 model manifest not found: ${path}`);
    }
    throw invalidManifest(`cannot read ${path}`);
  }
  const manifest = parseManifest(value);
  for (const file of manifest.files) existingModelFile(modelsDir, file.path);
  return manifest;
}

function manifestIfPresent(modelsDir: string): Maia3Manifest | null {
  const path = join(modelsDir, MANIFEST_FILE);
  if (!existsSync(path)) return null;
  return readManifest(modelsDir);
}

function legacyModelPath(modelsDir: string, modelKey: Maia3ModelKey): string | null {
  const path = resolve(modelsDir, `maia3-${modelKey}.onnx`);
  return existsSync(path) ? path : null;
}

export function resolveModelPath(options: ResolveModelPathOptions = {}): string {
  const packageModelsDir = options.packageModelsDir ?? resolve(here, "../../models");
  const cwd = options.cwd ?? process.cwd();
  const requested = options.modelKey ?? process.env.MAIA3_MODEL;
  const modelKey = requested || null;
  if (modelKey !== null && !isModelKey(modelKey)) {
    throw new Error(`unsupported Maia3 model: ${modelKey}`);
  }

  const packageManifest = manifestIfPresent(packageModelsDir);
  const cwdModelsDir = resolve(cwd, "models");

  if (modelKey === null) {
    const manifest = packageManifest;
    if (!manifest) {
      throw new Error(
        "Maia3 model manifest not found. Run `pnpm export:maia3` first.",
      );
    }
    return existingModelFile(packageModelsDir, manifest.modelFile);
  }

  const manifest = packageManifest;
  if (manifest && manifest.model === modelKey) {
    return existingModelFile(packageModelsDir, manifest.modelFile);
  }

  const packagePath = legacyModelPath(packageModelsDir, modelKey);
  if (packagePath) return packagePath;
  const cwdPath = legacyModelPath(cwdModelsDir, modelKey);
  if (cwdPath) return cwdPath;
  throw new Error(
    `maia3 model not found (models/maia3-${modelKey}.onnx). Run \`pnpm export:maia3\` first.`,
  );
}
