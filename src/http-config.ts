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
  return bindHost === "0.0.0.0" || bindHost === "::";
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
