import {
  canonicalHttpHostname,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isCanonicalHttpPath,
  isWildcardHttpBindHost,
} from "./http-config.js";

export type TransportKind = "stdio" | "http";

export type CliOptions = {
  transport: TransportKind;
  host: string;
  port: number;
  path: string;
  allowedHosts: string[];
  help: boolean;
};

export const HELP = `Usage: llm-chess-mcp [options]

Options:
  --transport <stdio|http>  Transport to use (default: stdio)
  --http                    Shortcut for --transport http
  --host <host>             HTTP bind host (default: 127.0.0.1)
  --port <port>             HTTP listen port (default: 3000)
  --path <path>             HTTP endpoint path (default: /mcp)
  --allowed-host <host>     Allowed HTTP Host/Origin hostname (repeatable)
  -h, --help                Show this help
`;

function optionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function splitOption(arg: string): [string, string] | null {
  const index = arg.indexOf("=");
  return index === -1 ? null : [arg.slice(0, index), arg.slice(index + 1)];
}

export function parseCli(args: string[]): CliOptions {
  let transport: TransportKind = "stdio";
  let host = DEFAULT_HTTP_HOST;
  let port = DEFAULT_HTTP_PORT;
  let path = DEFAULT_HTTP_PATH;
  let help = false;
  let hasHttpOption = false;
  const allowedHosts: string[] = [];

  if (args.includes("-h") || args.includes("--help")) {
    return { transport, host, port, path, allowedHosts, help: true };
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    const pair = splitOption(arg);
    const option = pair?.[0] ?? arg;
    const inlineValue = pair?.[1];
    const value = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = optionValue(args, index, option);
      index += 1;
      return next;
    };

    switch (option) {
      case "-h":
      case "--help":
        if (inlineValue !== undefined) throw new Error(`${option} takes no value`);
        help = true;
        break;
      case "--http":
        if (inlineValue !== undefined) throw new Error("--http takes no value");
        transport = "http";
        break;
      case "--transport": {
        const selected = value();
        if (selected !== "stdio" && selected !== "http") {
          throw new Error("--transport must be stdio or http");
        }
        transport = selected;
        break;
      }
      case "--host":
        host = value();
        hasHttpOption = true;
        break;
      case "--port": {
        const selected = value();
        if (!/^\d+$/.test(selected)) throw new Error("--port must be an integer");
        port = Number(selected);
        hasHttpOption = true;
        break;
      }
      case "--path":
        path = value();
        hasHttpOption = true;
        break;
      case "--allowed-host":
        allowedHosts.push(value());
        hasHttpOption = true;
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("--port must be between 1 and 65535");
  }
  if (!isCanonicalHttpPath(path)) {
    throw new Error("--path must be an absolute URL path without query or fragment");
  }
  const canonicalHost = canonicalHttpHostname(host);
  const canonicalAllowedHosts = allowedHosts.map(canonicalHttpHostname);
  if (
    canonicalHost === null ||
    canonicalAllowedHosts.some((value) => value === null)
  ) {
    throw new Error("HTTP hostnames must be non-empty hostnames");
  }
  if (transport === "stdio" && hasHttpOption) {
    throw new Error("HTTP options require --transport http");
  }
  if (
    transport === "http" &&
    isWildcardHttpBindHost(canonicalHost) &&
    canonicalAllowedHosts.length === 0
  ) {
    throw new Error("wildcard HTTP binding requires at least one --allowed-host");
  }

  return {
    transport,
    host: canonicalHost,
    port,
    path,
    allowedHosts: canonicalAllowedHosts as string[],
    help,
  };
}
