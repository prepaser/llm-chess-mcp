import { isIP } from "node:net";

const MAX_FORWARDED_FOR_BYTES = 2_048;
const MAX_FORWARDED_FOR_HOPS = 32;

export type HttpClientAddress = {
  address: string;
  key: string;
  fromProxy: boolean;
};

type IpValue = { version: 4 | 6; value: bigint };

function parseIpv4(value: string): IpValue | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) {
    return null;
  }
  let result = 0n;
  for (const part of parts) {
    const number = Number(part);
    if (number > 255) return null;
    result = (result << 8n) | BigInt(number);
  }
  return { version: 4, value: result };
}

function parseIpv6(value: string): IpValue | null {
  const unwrapped = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  if (!unwrapped || unwrapped.includes("%")) return null;
  const halves = unwrapped.split("::");
  if (halves.length > 2) return null;
  const parsePart = (part: string): number[] | null => {
    if (!part) return [];
    const pieces = part.split(":");
    const words: number[] = [];
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index]!;
      if (piece.includes(".")) {
        if (index !== pieces.length - 1) return null;
        const ipv4 = parseIpv4(piece);
        if (!ipv4) return null;
        words.push(Number(ipv4.value >> 16n), Number(ipv4.value & 0xffffn));
      } else if (/^[0-9a-f]{1,4}$/i.test(piece)) {
        words.push(Number.parseInt(piece, 16));
      } else {
        return null;
      }
    }
    return words;
  };
  const left = parsePart(halves[0]!);
  const right = parsePart(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const words = [...left, ...new Array(8 - left.length - right.length).fill(0), ...right];
  let result = 0n;
  for (const word of words) result = (result << 16n) | BigInt(word);
  return { version: 6, value: result };
}

function parseIp(value: string): IpValue | null {
  const trimmed = value.trim();
  const direct = isIP(trimmed) === 4
    ? parseIpv4(trimmed)
    : isIP(trimmed) === 6 || trimmed.includes(":")
      ? parseIpv6(trimmed)
      : null;
  if (!direct) return null;
  if (
    direct.version === 6 &&
    direct.value >> 32n === 0xffffn
  ) {
    return { version: 4, value: direct.value & 0xffffffffn };
  }
  return direct;
}

function formatIpv6(value: bigint): string {
  const words: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    words.push(Number((value >> BigInt((7 - index) * 16)) & 0xffffn));
  }
  let bestStart = -1;
  let bestLength = 0;
  for (let start = 0; start < words.length; start += 1) {
    if (words[start] !== 0) continue;
    let end = start;
    while (end < words.length && words[end] === 0) end += 1;
    if (end - start > bestLength && end - start >= 2) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end - 1;
  }
  if (bestStart < 0) return words.map((word) => word.toString(16)).join(":");
  const end = bestStart + bestLength;
  const left = words.slice(0, bestStart).map((word) => word.toString(16));
  const right = words.slice(end).map((word) => word.toString(16));
  if (left.length === 0 && right.length === 0) return "::";
  if (left.length === 0) return `::${right.join(":")}`;
  if (right.length === 0) return `${left.join(":")}::`;
  return `${left.join(":")}::${right.join(":")}`;
}

export function canonicalClientIp(address: string): string | null {
  const parsed = parseIp(address);
  if (!parsed) return null;
  return parsed.version === 4 ? formatIpv4(parsed.value) : formatIpv6(parsed.value);
}

function formatIpv4(value: bigint): string {
  return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

export function canonicalClientIpKey(address: string): string | null {
  const parsed = parseIp(address);
  if (!parsed) return null;
  if (parsed.version === 4) return formatIpv4(parsed.value);
  const prefix = parsed.value >> 64n;
  return `${formatIpv6(prefix << 64n)}/64`;
}

type Cidr = { version: 4 | 6; network: bigint; bits: number; mask: bigint };

function parseCidr(value: string): Cidr | null {
  const parts = value.trim().split("/");
  const address = parts[0];
  const bitsText = parts[1];
  if (!address || parts.length > 2) return null;
  if (bitsText !== undefined && !/^\d+$/.test(bitsText)) return null;
  const parsed = parseIp(address);
  if (!parsed) return null;
  const bits = bitsText === undefined ? (parsed.version === 4 ? 32 : 128) : Number(bitsText);
  const max = parsed.version === 4 ? 32 : 128;
  if (!Number.isInteger(bits) || bits < 0 || bits > max) return null;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(max - bits);
  return { version: parsed.version, network: parsed.value & mask, bits, mask };
}

export class TrustedProxySet {
  readonly #cidrs: readonly Cidr[];

  constructor(cidrs: readonly string[] = []) {
    const parsed = cidrs.map(parseCidr);
    if (parsed.some((cidr) => cidr === null)) {
      throw new Error("invalid trusted proxy CIDR");
    }
    this.#cidrs = parsed as Cidr[];
  }

  contains(address: string): boolean {
    const parsed = parseIp(address);
    return parsed
      ? this.#cidrs.some(
          (cidr) =>
            cidr !== null &&
            cidr.version === parsed.version &&
            (parsed.value & cidr.mask) === cidr.network,
        )
      : false;
  }
}

export function resolveClientIp(
  remoteAddress: string,
  forwardedFor: string | readonly string[] | undefined,
  trustedProxies: TrustedProxySet = new TrustedProxySet(),
): HttpClientAddress {
  const remote = canonicalClientIp(remoteAddress) ?? remoteAddress;
  const remoteKey = canonicalClientIpKey(remoteAddress) ?? remote;
  if (!trustedProxies.contains(remoteAddress) || forwardedFor === undefined) {
    return { address: remote, key: remoteKey, fromProxy: false };
  }
  const raw = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor as string;
  if (Buffer.byteLength(raw, "utf8") > MAX_FORWARDED_FOR_BYTES) {
    throw new Error("x-forwarded-for is too large");
  }
  const chain = raw.split(",").map((value: string) => value.trim());
  if (chain.length === 0 || chain.length > MAX_FORWARDED_FOR_HOPS || chain.some((value) => parseIp(value) === null)) {
    throw new Error("invalid x-forwarded-for chain");
  }
  chain.push(remoteAddress);
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]!;
    if (trustedProxies.contains(candidate)) continue;
    const address = canonicalClientIp(candidate);
    const key = canonicalClientIpKey(candidate);
    if (address && key) return { address, key, fromProxy: index < chain.length - 1 };
  }
  const first = chain[0]!;
  const address = canonicalClientIp(first);
  const key = canonicalClientIpKey(first);
  return address && key
    ? { address, key, fromProxy: true }
    : { address: remote, key: remoteKey, fromProxy: false };
}
