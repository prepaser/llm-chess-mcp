import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BearerAuthenticator,
  DEFAULT_HTTP_SECURITY_LIMITS,
  HttpSecurity,
  TrustedProxySet,
  canonicalClientIp,
  canonicalClientIpKey,
  loadBearerAuthenticator,
  resolveClientIp,
} from "../src/http-security.js";
import type { RateLimitKind, RateLimitDimension } from "../src/http-security.js";

test("Bearer authentication is optional but strict when configured", () => {
  const anonymous = new BearerAuthenticator();
  assert.deepEqual(anonymous.authenticate(undefined), { ok: true });

  const auth = new BearerAuthenticator(["secret-token"]);
  assert.equal(auth.authenticate(undefined).ok, false);
  assert.equal(auth.authenticate("Basic secret-token").ok, false);
  assert.equal(auth.authenticate("Bearer secret-token secret").ok, false);
  assert.equal(auth.authenticate(["Bearer secret-token", "Bearer secret-token"]).ok, false);
  const result = auth.authenticate("bearer secret-token");
  assert.equal(result.ok, true);
  if (result.ok) assert.match(result.identity?.digest ?? "", /^[0-9a-f]{64}$/);
  assert.equal(auth.authenticate("Bearer wrong").ok, false);
});

test("Bearer file loading rejects conflicting, empty, and invalid sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-chess-http-security-"));
  const file = join(directory, "bearers");
  try {
    await writeFile(file, "first\n\nsecond\n", "utf8");
    const auth = await loadBearerAuthenticator({ bearerFile: file });
    assert.equal(auth.authenticate("Bearer first").ok, true);
    assert.equal(auth.authenticate("Bearer second").ok, true);
    await assert.rejects(
      loadBearerAuthenticator({ bearer: "one", bearerFile: file }),
      /cannot be used together/,
    );
    await writeFile(file, "\n", "utf8");
    await assert.rejects(loadBearerAuthenticator({ bearerFile: file }), /must contain a token/);
    await writeFile(file, "not valid", "utf8");
    await assert.rejects(loadBearerAuthenticator({ bearerFile: file }), /invalid token/);
    await writeFile(file, Buffer.from([0xc3, 0x28]));
    await assert.rejects(loadBearerAuthenticator({ bearerFile: file }), /valid UTF-8/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("client IPs canonicalize IPv4-mapped addresses and IPv6 /64s", () => {
  assert.equal(canonicalClientIp("::ffff:192.0.2.9"), "192.0.2.9");
  assert.equal(canonicalClientIpKey("::ffff:192.0.2.9"), "192.0.2.9");
  assert.equal(canonicalClientIp("::"), "::");
  assert.equal(canonicalClientIp("::1"), "::1");
  assert.equal(canonicalClientIp("1::"), "1::");
  assert.equal(canonicalClientIp("2001:0db8:0000:0001:0000:0000:0000:0001"), "2001:db8:0:1::1");
  assert.equal(canonicalClientIpKey("2001:db8:0:1::1"), "2001:db8:0:1::/64");
});

test("trusted proxies resolve X-Forwarded-For from right to left", () => {
  const proxies = new TrustedProxySet(["192.0.2.0/24", "2001:db8:abcd::/48"]);
  assert.deepEqual(
    resolveClientIp("192.0.2.10", "198.51.100.4, 192.0.2.11", proxies),
    { address: "198.51.100.4", key: "198.51.100.4", fromProxy: true },
  );
  assert.equal(resolveClientIp("198.51.100.7", "203.0.113.4", proxies).address, "198.51.100.7");
  assert.throws(
    () => resolveClientIp("192.0.2.10", "198.51.100.4,not-an-ip", proxies),
    /invalid x-forwarded-for/,
  );
  assert.throws(
    () => resolveClientIp("192.0.2.10", new Array(33).fill("198.51.100.4"), proxies),
    /invalid x-forwarded-for/,
  );
  assert.throws(() => new TrustedProxySet(["not-a-cidr"]), /invalid trusted proxy CIDR/);
  assert.equal(new TrustedProxySet(["192.0.2.0/24", "192.0.2.0/24"]).contains("192.0.2.4"), true);
  assert.throws(
    () => resolveClientIp("192.0.2.10", "198.51.100.4".repeat(500), proxies),
    /x-forwarded-for is too large/,
  );
});

test("trusted proxy prefixes require decimal digits without implicit /0 coercion", () => {
  for (const address of ["127.0.0.1", "::1"]) {
    for (const prefix of ["", " ", "+0", "-0", "0x0", "0e0", "0.0", " 0", "Infinity", "NaN", "0/0"]) {
      assert.throws(() => new TrustedProxySet([`${address}/${prefix}`]), /invalid trusted proxy CIDR/);
    }
  }
  for (const address of ["127.0.0.1", "127.0.0.1/32", "::ffff:127.0.0.1/32"]) {
    const proxies = new TrustedProxySet([address]);
    assert.equal(proxies.contains("127.0.0.1"), true);
    assert.equal(proxies.contains("198.51.100.9"), false);
    assert.equal(resolveClientIp("198.51.100.9", "203.0.113.4", proxies).address, "198.51.100.9");
  }
  for (const address of ["::1", "::1/128"]) {
    const proxies = new TrustedProxySet([address]);
    assert.equal(proxies.contains("::1"), true);
    assert.equal(proxies.contains("2001:db8::1"), false);
  }
  assert.equal(new TrustedProxySet(["127.0.0.1/0"]).contains("198.51.100.9"), true);
  assert.equal(new TrustedProxySet(["::1/0"]).contains("2001:db8::1"), true);
});

test("HTTP security snapshots every rate-limit dimension before validating it", () => {
  for (const kind of ["request", "initialize", "work", "authFailure", "control"] satisfies RateLimitKind[]) {
    for (const dimension of ["global", "ip", "bearer"] satisfies RateLimitDimension[]) {
      let now = 0;
      const limit = { ratePerMinute: 1, burst: 1 };
      const security = new HttpSecurity({ [kind]: { [dimension]: limit } }, () => now);
      const subject = { ip: "192.0.2.1", bearer: "test" };
      assert.equal(security.consume(kind, subject, 1, [dimension]).allowed, true);
      limit.ratePerMinute = NaN;
      limit.burst = Infinity;
      assert.equal(security.consume(kind, subject, 1, [dimension]).allowed, false);
      now = 60_000;
      assert.equal(security.consume(kind, subject, 1, [dimension]).allowed, true);
      assert.equal(security.consume(kind, subject, 1, [dimension]).allowed, false);
      assert.throws(() => new HttpSecurity({ [kind]: { [dimension]: limit } }), /must be/);
    }
  }
});

test("HTTP security snapshots defaults without freezing caller-owned configuration", () => {
  const defaults = DEFAULT_HTTP_SECURITY_LIMITS.request.ip;
  const saved = { ...defaults };
  const security = new HttpSecurity({}, () => 0);
  try {
    defaults.burst = Infinity;
    defaults.ratePerMinute = NaN;
    for (let i = 0; i < saved.burst; i++) {
      assert.equal(security.consume("request", { ip: "192.0.2.1" }, 1, ["ip"]).allowed, true);
    }
    assert.equal(security.consume("request", { ip: "192.0.2.1" }, 1, ["ip"]).allowed, false);
  } finally {
    Object.assign(defaults, saved);
  }
});

test("HTTP security charges global and IP buckets and supports bearer-only charging", () => {
  let now = 0;
  const security = new HttpSecurity(
    {
      request: {
        global: { ratePerMinute: 60, burst: 2 },
        ip: { ratePerMinute: 60, burst: 2 },
        bearer: { ratePerMinute: 60, burst: 1 },
      },
      maxStateEntries: 100,
    },
    () => now,
  );
  const subject = { ip: "203.0.113.1", bearer: "digest" };
  assert.equal(security.consume("request", subject, 1, ["global", "ip"]).allowed, true);
  assert.equal(security.consume("request", subject, 1, ["bearer"]).allowed, true);
  assert.equal(security.consume("request", subject, 1, ["bearer"]).allowed, false);
  assert.equal(security.consume("request", subject, 1, ["global", "ip"]).allowed, true);
  assert.equal(security.consume("request", subject, 1, ["global", "ip"]).allowed, false);
  now += 1_000;
  assert.equal(security.consume("request", subject, 1, ["bearer"]).allowed, true);
});

test("HTTP security bounds active concurrency and keeps busy keys until release", () => {
  const security = new HttpSecurity({
    maxStateEntries: 10,
    maxConnectionsPerIp: 1,
    maxSessionsPerIp: 1,
    maxSessionsPerBearer: 1,
    maxWorkPerIp: 1,
    maxWorkPerBearer: 1,
  });
  const subject = { ip: "203.0.113.5", bearer: "digest" };
  const lease = security.acquire("connection", subject);
  assert.equal("release" in lease, true);
  const blockedConnection = security.acquire("connection", subject);
  assert.equal("allowed" in blockedConnection && !blockedConnection.allowed, true);
  if ("release" in lease) lease.release();
  const session = security.acquire("session", subject);
  assert.equal("release" in session, true);
  const blockedSession = security.acquire("session", subject);
  assert.equal("allowed" in blockedSession && !blockedSession.allowed, true);
  if ("release" in session) session.release();
  if ("release" in session) session.release();
});

test("HTTP security does not bypass partial buckets at TTL or when the clock moves backwards", () => {
  let now = 0;
  const security = new HttpSecurity(
    {
      request: {
        global: { ratePerMinute: 1, burst: 1 },
        ip: { ratePerMinute: 1, burst: 1 },
        bearer: { ratePerMinute: 1, burst: 1 },
      },
      stateTtlMs: 10,
    },
    () => now,
  );
  const subject = { ip: "198.51.100.8" };
  assert.equal(security.consume("request", subject).allowed, true);
  now = 5;
  assert.equal(security.consume("request", subject).allowed, false);
  now = 0;
  assert.equal(security.consume("request", subject).allowed, false);
  now = 60_000;
  assert.equal(security.consume("request", subject).allowed, true);
  assert.equal(security.stateSize, 2);
});

test("HTTP security keeps the total state cap across buckets and leases", () => {
  const security = new HttpSecurity({
    maxStateEntries: 2,
    request: {
      global: { ratePerMinute: 60, burst: 2 },
      ip: { ratePerMinute: 60, burst: 2 },
      bearer: { ratePerMinute: 60, burst: 2 },
    },
    maxConnectionsPerIp: 1,
  });
  assert.equal(security.consume("request", { ip: "198.51.100.1" }).allowed, true);
  assert.equal(security.stateSize, 2);
  const denied = security.acquire("connection", { ip: "198.51.100.2" });
  assert.equal("allowed" in denied && !denied.allowed, true);
  assert.equal(security.stateSize, 2);
});

test("HTTP security sweeps expired full buckets before acquiring a new lease", () => {
  let now = 0;
  const security = new HttpSecurity(
    {
      maxStateEntries: 2,
      stateTtlMs: 10,
      request: {
        global: { ratePerMinute: 60_000, burst: 1 },
        ip: { ratePerMinute: 60_000, burst: 1 },
        bearer: { ratePerMinute: 60_000, burst: 1 },
      },
      maxConnectionsPerIp: 1,
    },
    () => now,
  );
  assert.equal(security.consume("request", { ip: "198.51.100.3" }).allowed, true);
  now = 20;
  const lease = security.acquire("connection", { ip: "198.51.100.4" });
  assert.equal("release" in lease, true);
  if ("release" in lease) lease.release();
});

test("HTTP security reports the slowest retry across charged dimensions without partial charge", () => {
  let now = 0;
  const security = new HttpSecurity(
    {
      request: {
        global: { ratePerMinute: 60, burst: 1 },
        ip: { ratePerMinute: 6, burst: 1 },
        bearer: { ratePerMinute: 60, burst: 1 },
      },
    },
    () => now,
  );
  const subject = { ip: "198.51.100.9", bearer: "digest" };
  assert.equal(security.consume("request", subject).allowed, true);
  const denied = security.consume("request", subject);
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterMs >= 10_000);
  now += 10_000;
  assert.equal(security.consume("request", subject).allowed, true);
});

test("a successful charge during clock rollback cannot mint tokens", () => {
  let now = 100;
  const limit = { ratePerMinute: 60_000, burst: 2 };
  const security = new HttpSecurity({ request: { global: limit, ip: limit } }, () => now);
  const subject = { ip: "198.51.100.11" };
  assert.equal(security.consume("request", subject).allowed, true);
  now = 90;
  assert.equal(security.consume("request", subject).allowed, true);
  now = 100;
  assert.equal(security.consume("request", subject).allowed, false);
});

test("HTTP security check peeks without charging and rejects an exhausted bucket", () => {
  const security = new HttpSecurity({
    authFailure: {
      global: { ratePerMinute: 60, burst: 1 },
      ip: { ratePerMinute: 60, burst: 1 },
      bearer: { ratePerMinute: 0, burst: 1 },
    },
  });
  const subject = { ip: "198.51.100.10" };
  assert.equal(security.check("authFailure", subject).allowed, true);
  assert.equal(security.check("authFailure", subject).allowed, true);
  assert.equal(security.consume("authFailure", subject).allowed, true);
  assert.equal(security.check("authFailure", subject).allowed, false);
  assert.equal(security.check("authFailure", subject).allowed, false);
});

test("Bearer files are bounded before authentication state is built", async () => {
  const directory = await mkdtemp(join(tmpdir(), "llm-chess-http-security-large-"));
  const file = join(directory, "bearers");
  try {
    await writeFile(file, `${"a".repeat(4_096)}\n`.repeat(300), "utf8");
    await assert.rejects(loadBearerAuthenticator({ bearerFile: file }), /too large|too many/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
