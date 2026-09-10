import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STOCKFISH_FLAVORS = [
  "full",
  "lite",
  "single",
  "lite-single",
  "single-lite",
  "asm",
] as const;

export type StockfishFlavor = (typeof STOCKFISH_FLAVORS)[number];

export type StockfishConfig = {
  version: string;
  flavor: StockfishFlavor;
};

const DEFAULT_FLAVOR: StockfishFlavor = "lite-single";
const FLAVORS = new Set<string>(STOCKFISH_FLAVORS);
const STABLE_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export function validateStockfishVersion(value: unknown, label = "stockfish version"): string {
  if (typeof value !== "string" || value.trim() !== value || !STABLE_VERSION.test(value)) {
    throw new Error(`${label} must be an exact stable x.y.z version`);
  }
  return value;
}

export function validateStockfishFlavor(
  value: unknown,
  label = "stockfish flavor",
): StockfishFlavor {
  if (typeof value !== "string" || !FLAVORS.has(value.toLowerCase())) {
    throw new Error(
      `${label} must be one of ${STOCKFISH_FLAVORS.join(", ")}`,
    );
  }
  return value.toLowerCase() as StockfishFlavor;
}

export function resolveStockfishFlavor(value?: string): StockfishFlavor {
  if (value === undefined || value.trim() === "") return DEFAULT_FLAVOR;
  try {
    return validateStockfishFlavor(value, "STOCKFISH_FLAVOR");
  } catch {
    throw new Error(
      `invalid STOCKFISH_FLAVOR: ${JSON.stringify(value)}; expected one of ${STOCKFISH_FLAVORS.join(", ")}`,
    );
  }
}

function packageObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stockfish package metadata must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function readStockfishConfig(
  packageJsonPath = join(PACKAGE_ROOT, "package.json"),
): StockfishConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  } catch (error) {
    throw new Error(
      `unable to read stockfish package metadata at ${packageJsonPath}`,
      { cause: error },
    );
  }

  const packageJson = packageObject(parsed);
  const metadata = packageJson.stockfish;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error(
      `stockfish package metadata is missing from ${packageJsonPath}`,
    );
  }
  const metadataObject = metadata as Record<string, unknown>;
  if (Object.keys(metadataObject).sort().join(",") !== "flavor") {
    throw new Error(
      `stockfish package metadata at ${packageJsonPath} must contain only flavor`,
    );
  }
  const dependencies = packageJson.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    throw new Error(`stockfish dependencies are missing from ${packageJsonPath}`);
  }
  const version = validateStockfishVersion(
    (dependencies as Record<string, unknown>).stockfish,
    "dependencies.stockfish",
  );
  const flavor = validateStockfishFlavor(
    metadataObject.flavor,
    "stockfish.flavor",
  );
  return { version, flavor };
}

export function assertStockfishVersion(
  expectedVersion: string,
  installedVersion: unknown,
  installedPackageJsonPath?: string,
): void {
  const expected = validateStockfishVersion(expectedVersion, "dependencies.stockfish");
  const installed = validateStockfishVersion(
    installedVersion,
    "installed stockfish version",
  );
  if (expected === installed) return;
  const location = installedPackageJsonPath
    ? ` at ${installedPackageJsonPath}`
    : "";
  throw new Error(
    `stockfish version mismatch: package requires ${expected}, but installed stockfish is ${installed}${location}`,
  );
}

export function resolveConfiguredStockfishFlavor(
  explicit: string | undefined,
  environment: string | undefined,
  metadata: StockfishConfig | undefined,
): StockfishFlavor {
  if (explicit !== undefined) return resolveStockfishFlavor(explicit);
  if (environment !== undefined && environment.trim() !== "") {
    return resolveStockfishFlavor(environment);
  }
  return metadata?.flavor ?? DEFAULT_FLAVOR;
}
