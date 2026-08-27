import { isIP } from "node:net";

export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_PORT = 3_000;
export const DEFAULT_HTTP_PATH = "/mcp";

export function bindHttpHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") && host.includes(":")
    ? host.slice(1, -1)
    : host;
}

export function isWildcardHttpBindHost(host: string): boolean {
  const bindHost = bindHttpHost(host);
  const ipVersion = isIP(bindHost);
  if (ipVersion === 6) {
    return new URL(`http://[${bindHost}]`).hostname === "[::]";
  }
  if (ipVersion === 4) return bindHost === "0.0.0.0";
  try {
    return new URL(`http://${bindHost}`).hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

export function canonicalHttpHostname(host: string): string | null {
  if (!host || host !== host.trim() || /[\\/?#@]/.test(host)) return null;
  const normalized = host.toLowerCase();
  const unwrapped = bindHttpHost(normalized);
  if (isIP(unwrapped) === 6) {
    return new URL(`http://[${unwrapped}]`).hostname;
  }
  if (/[\[\]:]/.test(normalized)) return null;
  try {
    const url = new URL(`http://${normalized}`);
    return url.username || url.password || url.port || !url.hostname
      ? null
      : url.hostname;
  } catch {
    return null;
  }
}

export function canonicalHttpPath(path: string): string | null {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#")
  ) {
    return null;
  }
  try {
    return new URL(path, "http://localhost").pathname === path ? path : null;
  } catch {
    return null;
  }
}

export function isCanonicalHttpPath(path: string): boolean {
  return canonicalHttpPath(path) !== null;
}
