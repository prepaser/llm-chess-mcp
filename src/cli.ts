import { isIP } from "node:net";
import {
  canonicalHttpHostname,
  bindHttpHost,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_PATH,
  DEFAULT_HTTP_PORT,
  isCanonicalHttpPath,
  isWildcardHttpBindHost,
  validateHttpTlsPortCollision,
} from "./http-config.js";
import { DEFAULT_HTTP_SECURITY_LIMITS, TrustedProxySet } from "./http-security.js";
import type {
  HttpRateLimitOptions,
  RateLimit,
  SecurityRateLimitConfig,
} from "./http-security.js";
import type { HttpTlsOptions } from "./http-tls.js";

export type TransportKind = "stdio" | "http";

export type CliRateLimitOptions = HttpRateLimitOptions;
export type CliTlsOptions = Exclude<HttpTlsOptions, { mode: "off" }>;

type RateLimitKind = "request" | "initialize" | "work" | "authFailure" | "control";
type RateLimitDimension = "global" | "ip" | "bearer";

export type CliOptions = {
  transport: TransportKind;
  host: string;
  port: number;
  path: string;
  allowedHosts: string[];
  bearerFile?: string;
  trustedProxies?: string[];
  rateLimits?: CliRateLimitOptions;
  tls?: CliTlsOptions;
  maxSessions?: number;
  maxConcurrentPosts?: number;
  maxConcurrentPostsPerSession?: number;
  maxConnections?: number;
  help: boolean;
};

export const HELP = `Usage: llm-chess-mcp [options]

Options:
  --transport <stdio|http>  Transport to use (default: stdio)
  --http                    Shortcut for --transport http
  --host <host>             HTTP bind host (default: 127.0.0.1)
  --port <port>             HTTP listen port; 0 selects an available port (default: 3000)
  --path <path>             HTTP endpoint path (default: /mcp)
  --allowed-host <host>     Allowed HTTP Host hostname (repeatable)
  --bearer-file <path>      File containing one HTTP Bearer per line
  --trusted-proxy <cidr>    Trust X-Forwarded-For from this proxy (repeatable)
  --rate-limit-<dimension>-<kind>-per-minute <n>
                            dimension: global|ip|bearer; kind: request|initialize|work|auth-failure|control
  --rate-limit-<dimension>-<kind>-burst <n>
  --rate-limit-state-entries <n>
  --rate-limit-state-ttl-ms <n>
  --max-connections-per-ip <n>
  --max-sessions-per-ip <n>
  --max-sessions-per-bearer <n>
  --max-work-per-ip <n>
  --max-work-per-bearer <n>
  --max-sessions <n>        Global HTTP session limit
  --max-connections <n>     Global TCP connection limit
  --max-concurrent-posts <n>
  --max-concurrent-posts-per-session <n>
  --tls-cert <path>         PEM certificate for manual TLS
  --tls-key <path>          PEM private key for manual TLS
  --acme-domain <hostname>  ACME HTTP-01 certificate hostname
  --acme-email <email>      ACME account contact email
  --acme-agree-tos          Agree to the ACME provider terms
  --acme-storage <path>     ACME account/certificate storage directory
  --acme-staging            Use the ACME staging endpoint
  --acme-challenge-host <host>
                            HTTP-01 challenge listener bind host
  --acme-challenge-port <n> HTTP-01 challenge listener port (default: 80)
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

function positiveInteger(option: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${option} must be a positive integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${option} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(option: string, raw: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`${option} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${option} must be a non-negative integer`);
  }
  return value;
}

function nonEmptyValue(option: string, raw: string): string {
  if (!raw.trim()) throw new Error(`${option} requires a non-empty value`);
  return raw;
}

function rateLimitKind(value: string): RateLimitKind | null {
  return value === "request" || value === "initialize" || value === "work" ||
      value === "authFailure" || value === "control"
    ? value
    : null;
}

function setRateLimit(
  limits: HttpRateLimitOptions,
  kind: RateLimitKind,
  dimension: RateLimitDimension,
  field: keyof RateLimit,
  value: number,
): void {
  const config = (limits[kind] ??= {}) as SecurityRateLimitConfig;
  const current = (config[dimension] ??= {
    ...DEFAULT_HTTP_SECURITY_LIMITS[kind][dimension],
  });
  current[field] = value;
}

export function parseCli(args: string[]): CliOptions {
  let transport: TransportKind = "stdio";
  let host = DEFAULT_HTTP_HOST;
  let port = DEFAULT_HTTP_PORT;
  let path = DEFAULT_HTTP_PATH;
  let help = false;
  let hasHttpOption = false;
  let explicitPort = false;
  const allowedHosts: string[] = [];
  const trustedProxies: string[] = [];
  const rateLimits: HttpRateLimitOptions = {};
  let hasRateLimitOption = false;
  let bearerFile: string | undefined;
  let tlsCert: string | undefined;
  let tlsKey: string | undefined;
  let acmeDomain: string | undefined;
  let acmeEmail: string | undefined;
  let acmeStorage: string | undefined;
  let acmeAgreeTos = false;
  let acmeStaging = false;
  let acmeChallengePort = 80;
  let acmeChallengeHost: string | undefined;
  let hasAcmeOption = false;
  let maxSessions: number | undefined;
  let maxConcurrentPosts: number | undefined;
  let maxConcurrentPostsPerSession: number | undefined;
  let maxConnections: number | undefined;

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

    const rateOption = /^--rate-limit-(global|ip|bearer)-(request|initialize|work|auth-failure|control)-(per-minute|burst)$/.exec(option);
    if (rateOption) {
      const dimension = rateOption[1] as RateLimitDimension;
      const rawKind = rateOption[2];
      if (!rawKind) throw new Error(`unknown rate-limit kind`);
      const kind = rateLimitKind(rawKind === "auth-failure" ? "authFailure" : rawKind);
      if (!kind) throw new Error(`unknown rate-limit kind: ${rawKind}`);
      setRateLimit(
        rateLimits,
        kind,
        dimension,
        rateOption[3] === "per-minute" ? "ratePerMinute" : "burst",
        rateOption[3] === "per-minute"
          ? nonNegativeInteger(option, value())
          : positiveInteger(option, value()),
      );
      hasRateLimitOption = true;
      hasHttpOption = true;
      continue;
    }

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
        explicitPort = true;
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
      case "--bearer-file":
        bearerFile = nonEmptyValue(option, value());
        hasHttpOption = true;
        break;
      case "--trusted-proxy":
        trustedProxies.push(nonEmptyValue(option, value()));
        hasHttpOption = true;
        break;
      case "--rate-limit-state-entries":
        rateLimits.maxStateEntries = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--rate-limit-state-ttl-ms":
        rateLimits.stateTtlMs = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-connections-per-ip":
        rateLimits.maxConnectionsPerIp = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-sessions-per-ip":
        rateLimits.maxSessionsPerIp = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-sessions-per-bearer":
        rateLimits.maxSessionsPerBearer = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-work-per-ip":
        rateLimits.maxWorkPerIp = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-work-per-bearer":
        rateLimits.maxWorkPerBearer = positiveInteger(option, value());
        hasRateLimitOption = true;
        hasHttpOption = true;
        break;
      case "--max-sessions":
        maxSessions = positiveInteger(option, value());
        hasHttpOption = true;
        break;
      case "--max-connections":
        maxConnections = positiveInteger(option, value());
        hasHttpOption = true;
        break;
      case "--max-concurrent-posts":
        maxConcurrentPosts = positiveInteger(option, value());
        hasHttpOption = true;
        break;
      case "--max-concurrent-posts-per-session":
        maxConcurrentPostsPerSession = positiveInteger(option, value());
        hasHttpOption = true;
        break;
      case "--tls-cert":
        tlsCert = nonEmptyValue(option, value());
        hasHttpOption = true;
        break;
      case "--tls-key":
        tlsKey = nonEmptyValue(option, value());
        hasHttpOption = true;
        break;
      case "--acme-domain":
        acmeDomain = nonEmptyValue(option, value());
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-email":
        acmeEmail = nonEmptyValue(option, value());
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-agree-tos":
        if (inlineValue !== undefined) throw new Error("--acme-agree-tos takes no value");
        acmeAgreeTos = true;
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-storage":
        acmeStorage = nonEmptyValue(option, value());
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-staging":
        if (inlineValue !== undefined) throw new Error("--acme-staging takes no value");
        acmeStaging = true;
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-challenge-host":
        acmeChallengeHost = nonEmptyValue(option, value());
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      case "--acme-challenge-port": {
        const selected = positiveInteger(option, value());
        if (selected > 65_535) throw new Error("--acme-challenge-port must be between 1 and 65535");
        acmeChallengePort = selected;
        hasAcmeOption = true;
        hasHttpOption = true;
        break;
      }
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("--port must be between 0 and 65535");
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
  if (trustedProxies.length > 0) {
    try {
      new TrustedProxySet(trustedProxies);
    } catch {
      throw new Error("--trusted-proxy must contain valid IP addresses or CIDRs");
    }
  }
  if (transport === "stdio" && hasHttpOption) {
    throw new Error("HTTP options require --transport http");
  }

  if ((tlsCert !== undefined || tlsKey !== undefined) && hasAcmeOption) {
    throw new Error("manual TLS and ACME options cannot be combined");
  }
  let tls: CliTlsOptions | undefined;
  if (tlsCert !== undefined || tlsKey !== undefined) {
    if (tlsCert === undefined || tlsKey === undefined) {
      throw new Error("--tls-cert and --tls-key must be provided together");
    }
    tls = { mode: "manual", certPath: tlsCert, keyPath: tlsKey };
  } else if (hasAcmeOption) {
    if (acmeDomain === undefined || acmeEmail === undefined || acmeStorage === undefined) {
      throw new Error("ACME requires --acme-domain, --acme-email, and --acme-storage");
    }
    if (!acmeAgreeTos) throw new Error("ACME requires --acme-agree-tos");
    const canonicalDomain = canonicalHttpHostname(acmeDomain);
    if (canonicalDomain === null || isIP(canonicalDomain) !== 0) {
      throw new Error("--acme-domain must be a hostname");
    }
    tls = {
      mode: "acme",
      domain: canonicalDomain,
      email: acmeEmail,
      storageDir: acmeStorage,
      termsOfServiceAgreed: true,
      challengePort: acmeChallengePort,
      ...(acmeChallengeHost === undefined ? {} : { challengeHost: acmeChallengeHost }),
      ...(acmeStaging ? { directoryUrl: "https://acme-staging-v02.api.letsencrypt.org/directory" } : {}),
    };
  }
  if (tls !== undefined && !explicitPort) port = 443;
  if (tls?.mode === "acme") {
    if (tls.challengeHost !== undefined) {
      const challengeHost = canonicalHttpHostname(tls.challengeHost);
      if (challengeHost === null) throw new Error("--acme-challenge-host must be a hostname");
      tls.challengeHost = bindHttpHost(challengeHost);
    }
    validateHttpTlsPortCollision(port, tls);
  }
  if (
    transport === "http" &&
    isWildcardHttpBindHost(canonicalHost) &&
    canonicalAllowedHosts.length === 0
  ) {
    throw new Error("wildcard HTTP binding requires at least one --allowed-host");
  }

  const result: CliOptions = {
    transport,
    host: canonicalHost,
    port,
    path,
    allowedHosts: canonicalAllowedHosts as string[],
    help,
  };
  if (bearerFile !== undefined) result.bearerFile = bearerFile;
  if (trustedProxies.length > 0) result.trustedProxies = trustedProxies;
  if (hasRateLimitOption) result.rateLimits = rateLimits;
  if (tls !== undefined) result.tls = tls;
  if (maxSessions !== undefined) result.maxSessions = maxSessions;
  if (maxConcurrentPosts !== undefined) result.maxConcurrentPosts = maxConcurrentPosts;
  if (maxConcurrentPostsPerSession !== undefined) {
    result.maxConcurrentPostsPerSession = maxConcurrentPostsPerSession;
  }
  if (maxConnections !== undefined) result.maxConnections = maxConnections;
  return result;
}
