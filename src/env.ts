import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ALLOWED_KEYS = new Set(["LICHESS_TOKEN", "MAIA3_MODEL", "STOCKFISH_FLAVOR"]);

export function loadEnv(path = ".env"): void {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), path), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (ALLOWED_KEYS.has(key) && process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}
