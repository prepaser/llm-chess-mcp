import { createHash, timingSafeEqual } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";

const MAX_BEARER_FILE_BYTES = 1 << 20;
const MAX_BEARER_FILE_TOKENS = 10_000;

export type BearerAuthOptions = {
  bearer?: string;
  bearerFile?: string;
};

export type HttpAuthOptions = BearerAuthOptions;

export type BearerIdentity = {
  digest: string;
};

export type BearerAuthentication =
  | { ok: true; identity?: BearerIdentity }
  | { ok: false; reason: "missing" | "malformed" | "invalid" };

const TOKEN_MAX_LENGTH = 4_096;

function digestBearer(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function validBearer(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= TOKEN_MAX_LENGTH &&
    /^[A-Za-z0-9\-._~+/]+=*$/.test(value)
  );
}

export class BearerAuthenticator {
  readonly #digests: readonly Buffer[];

  constructor(tokens: readonly string[] = []) {
    if (tokens.length > 0 && tokens.some((token) => !validBearer(token))) {
      throw new Error("bearer tokens must be non-empty and contain no whitespace");
    }
    const unique = new Map<string, Buffer>();
    for (const token of tokens) {
      const digest = digestBearer(token);
      unique.set(digest.toString("hex"), digest);
    }
    this.#digests = [...unique.values()];
  }

  get enabled(): boolean {
    return this.#digests.length > 0;
  }

  authenticate(
    authorization: string | readonly string[] | undefined,
  ): BearerAuthentication {
    if (!this.enabled) return { ok: true };
    if (authorization === undefined) return { ok: false, reason: "missing" };
    if (Array.isArray(authorization)) {
      return { ok: false, reason: "malformed" };
    }
    const match = /^Bearer ([^\s]+)$/i.exec(authorization as string);
    const token = match?.[1];
    if (!token || !validBearer(token)) {
      return { ok: false, reason: "malformed" };
    }
    const digest = digestBearer(token);
    let valid = false;
    for (const expected of this.#digests) {
      if (timingSafeEqual(expected, digest)) valid = true;
    }
    if (!valid) return { ok: false, reason: "invalid" };
    return { ok: true, identity: { digest: digest.toString("hex") } };
  }
}

function readBearerFile(text: string): string[] {
  const tokens = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (tokens.some((token) => !validBearer(token))) {
    throw new Error("bearer file contains an invalid token");
  }
  if (tokens.length > MAX_BEARER_FILE_TOKENS) {
    throw new Error("bearer file contains too many tokens");
  }
  if (tokens.length === 0) throw new Error("bearer file must contain a token");
  return tokens;
}

export async function loadBearerAuthenticator(
  options: BearerAuthOptions = {},
): Promise<BearerAuthenticator> {
  if (options.bearer !== undefined && options.bearerFile !== undefined) {
    throw new Error("bearer and bearerFile cannot be used together");
  }
  if (options.bearer !== undefined) {
    if (!validBearer(options.bearer)) throw new Error("invalid bearer token");
    return new BearerAuthenticator([options.bearer]);
  }
  if (options.bearerFile !== undefined) {
    if (!options.bearerFile) throw new Error("bearerFile must not be empty");
    const path = resolve(options.bearerFile);
    const initialStat = await lstat(path);
    if (!initialStat.isFile()) throw new Error("bearer file must be a regular file");
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("bearer file must be a regular file");
      if (stat.size > MAX_BEARER_FILE_BYTES) throw new Error("bearer file is too large");
      const buffer = Buffer.alloc(MAX_BEARER_FILE_BYTES + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const result = await handle.read(buffer, offset, buffer.length - offset, offset);
        offset += result.bytesRead;
        if (result.bytesRead === 0) break;
      }
      if (offset > MAX_BEARER_FILE_BYTES) throw new Error("bearer file is too large");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
      } catch {
        throw new Error("bearer file is not valid UTF-8");
      }
      return new BearerAuthenticator(readBearerFile(text));
    } finally {
      await handle.close();
    }
  }
  return new BearerAuthenticator();
}
