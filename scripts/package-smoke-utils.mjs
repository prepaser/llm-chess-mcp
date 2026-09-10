import { constants } from "node:fs";
import { access, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

export const PACKAGE_SMOKE_DIAGNOSTIC_LIMIT = 64 * 1024;

function text(value) {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function limitText(value, limit = PACKAGE_SMOKE_DIAGNOSTIC_LIMIT) {
  const source = text(value);
  if (source.length <= limit) return source;
  const head = Math.ceil(limit / 2);
  const tail = Math.floor(limit / 2);
  return `${source.slice(0, head)}\n[…truncated…]\n${source.slice(-tail)}`;
}

function errorDetails(error, depth = 0) {
  if (depth > 3) return "[cause chain truncated]";
  if (!(error instanceof Error)) return limitText(error, 8 * 1024);
  const details = [
    `${error.name}: ${error.message}`,
    ...("code" in error && error.code ? [`code: ${error.code}`] : []),
    ...("cmd" in error && error.cmd ? [`command: ${error.cmd}`] : []),
    ...("stdout" in error && error.stdout ? [`stdout:\n${limitText(error.stdout, 12 * 1024)}`] : []),
    ...("stderr" in error && error.stderr ? [`stderr:\n${limitText(error.stderr, 24 * 1024)}`] : []),
    ...(error.cause === undefined ? [] : [`cause:\n${errorDetails(error.cause, depth + 1)}`]),
  ];
  return details.join("\n");
}

export function isStorageCapacityError(error) {
  const source = errorDetails(error);
  return /\b(?:EDQUOT|ENOSPC)\b|disk quota|no space left on device|quota exceeded|system error\s*-?(?:122|28)\b/i.test(source);
}

export function storageCapacityGuidance(error, tmpRoot) {
  if (!isStorageCapacityError(error)) return "";
  const configured = text(tmpRoot);
  return [
    "Package smoke ran out of writable storage or quota.",
    configured
      ? `PACKAGE_SMOKE_TMPDIR is currently ${configured}; choose a writable path with more quota.`
      : "Set PACKAGE_SMOKE_TMPDIR to a writable path with more quota before retrying.",
    "The smoke test removes its temporary install after completion.",
  ].join(" ");
}

function isWithin(child, parent) {
  const childRelative = relative(parent, child);
  return childRelative === "" || (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

async function npmLogPaths(workspace) {
  if (!workspace) return [];
  const directory = join(workspace, "npm-cache", "_logs");
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".log"))
      .map((entry) => entry.name).sort().slice(-3).map((name) => join(directory, name));
  } catch {
    return [];
  }
}

async function readBoundedFile(path, limit) {
  let handle;
  try {
    if (!(await lstat(path)).isFile()) return null;
    handle = await open(path, "r");
    const { size } = await handle.stat();
    if (size <= limit) {
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await handle.read(buffer, 0, size, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    }
    const headSize = Math.ceil(limit / 2);
    const tailSize = Math.floor(limit / 2);
    const head = Buffer.alloc(headSize);
    const tail = Buffer.alloc(tailSize);
    await handle.read(head, 0, headSize, 0);
    await handle.read(tail, 0, tailSize, Math.max(0, size - tailSize));
    return `${head.toString("utf8")}\n[…truncated…]\n${tail.toString("utf8")}`;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export function formatPackageSmokeFailure({ error, workspace, tmpRoot, timestamp = new Date().toISOString() }) {
  const sections = [
    "package smoke failure",
    `time: ${timestamp}`,
    `workspace: ${workspace ?? "unknown"}`,
    `temporary root: ${tmpRoot ?? "unknown"}`,
    "",
    errorDetails(error),
  ];
  const guidance = storageCapacityGuidance(error, tmpRoot);
  if (guidance) sections.push("", guidance);
  return limitText(sections.join("\n"));
}

export async function writePackageSmokeDiagnostic({ error, workspace, tmpRoot, repoRoot, logRoot }) {
  const fallbackRoot = join(repoRoot, ".package-smoke-failures");
  const configuredRoot = logRoot ? resolve(repoRoot, logRoot) : fallbackRoot;
  const destinationRoot = workspace && isWithin(configuredRoot, resolve(workspace))
    ? fallbackRoot
    : configuredRoot;
  try {
    await mkdir(destinationRoot, { recursive: true });
    await access(destinationRoot, constants.W_OK);
    const stamp = new Date().toISOString().replaceAll(/[^0-9]/g, "").slice(0, 17);
    const path = join(destinationRoot, `failure-${stamp}-${process.pid}.log`);
    const sections = [formatPackageSmokeFailure({ error, workspace, tmpRoot })];
    for (const referencedPath of await npmLogPaths(workspace)) {
      const log = await readBoundedFile(referencedPath, 24 * 1024);
      if (log !== null) sections.push(`\nnpm log: ${referencedPath}\n${log}`);
    }
    await writeFile(path, limitText(sections.join("\n")), { encoding: "utf8", mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

export async function cleanupPackageSmokeWorkspace(workspace, primaryError, remove = rm) {
  if (!workspace) return;
  try {
    await remove(workspace, { recursive: true, force: true });
  } catch (error) {
    if (primaryError) return error;
    throw error;
  }
}
