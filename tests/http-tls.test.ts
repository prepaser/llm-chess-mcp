import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, get as httpGet, type Server } from "node:http";
import { createServer as createHttpsServer, get as httpsGet } from "node:https";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { connect as connectTls } from "node:tls";
import { X509Certificate } from "node:crypto";
import test from "node:test";
import { prepareHttpTls } from "../src/http-tls.js";
import { installAcmeAbortPolling, type AcmeClient } from "../src/http-tls-acme.js";
import { serveHttp } from "../src/http.js";
import { resolveHttpConfig } from "../src/http-config.js";

const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCrCbcj/bZqSrwi
k/TWAG4wXi6SLCiGs5ognLto6GwEPikCI5yGyTG/1NA+9KYCv6wDoJJF1OOWiQ88
ti5gGOdct+n/z6BOsptU+dUpk7g3bsJ/2O+8SZkQ+BcFdxV3k5DQ7LPn5INZ0FF5
nJx93o7WDH3wGBwqklsGoMV7pA4GOV8OdmSyjF9I5Le/5U2XAGkgp6SFk1tb1fMG
1iCO+eGSgrj0b4PuqZWZNb8ssCnBd4CqH6Su2Gy3mYyJwrmr3fx+PxC6F9rsh3ka
cj7k3YOwsXOa9hEj3KkCfEMu6OgWuE/J73c6RtS4Vr5lp6N3Gl5FyWquVCxLCsqK
u/tWR3RLAgMBAAECggEAIHtB2oXuRJVY0UBD+Pgv9OON+JiGQb6OAK+DL9Mj4FJl
u1BEA5zl48ZonewcMt1vr2ipHrXlWstAp4j5maphFcyflcM6cHee5C5l+vVgwLY6
Hcl3Dcz0UrKqvJD29LSDhgnNyLYu87mKH4xMc+L2QVQx/oy1nKgavVF+75IiT6/5
10lOx/VlDoesZeZtPVH2/3l+azmNfzSpEZqpAONraKK8++R8FAuJimgE6U7nk1Mt
zUWRJI1OposDCymkynr4Sv8Ny6MagM0DYny6k4V1hxVeKm1SisCQIS0SHPTijIgt
C+nCCEx5Ewk/5tGMBq379OW8TWenZRCscVtKD7pjcQKBgQDhoHuEAaH7MbunGlLX
Lybe68pa4E3XiLmv/ycJ5KJ4tfMEsVgmFFvQVUyCsk7L+3pfOyGTVUcr9hot1Mfp
nnQIRfVt6XsiWuvsqLlptnnhmiikSztZxYiffWh91nJvrQLSjNUAh6iLc+FF1FAZ
Ml2gxgwGc1fjpXYMF2xPXHQWVwKBgQDCD/9xTiPr+ErHY6cMkENr+1gA8MKEgiXs
bf+/Qc1DV8QKBW/QNGc+SykODCKSbMlltoC2bt4Szt/OJTr9DfQeojCGlIha2+mK
ugouZ108OEpBOdrIpQ/6LksIkGO4w6mG3PKvQsusivZWDUKVaYOgxEgVTgh8N/0e
1eH4LuJRLQKBgAksxnkKu/SEBDZ6Wo4Hi9Qa0IK7hk7Sb4KZpJPBaV3xQC2brJL3
1vf00ASsjYm78zD2LZpZKGjAPDZK5co5OEyx05YhnXE7M0bPYaLL2c7zvt1XddVj
s/eQWPRtCQBDj87SDUNVQORS1QFK7eroYmhMRWbpv9QxAUjilvPvNYVHAoGAEsYB
bDCnAPjwIwHc8zYxj4ytIsonxzHgAVNS3mm7NbyT1nRYMMghBMG4owdBgPDNOu3A
3eUzzpX8yLCJWFm1OBFwqFROLJwBp83/liWhu2WmqVCzfZ2aQhWgZJ+zRfiHueg+
Af5wPazjz8dQnaurdC4I2ybFY173ObhvN9cxRbECgYEAhXVnwpokgIS8yHYswwpd
AsODnvmwEHxu49y9+EhdUlKygadkyHcPdW50mJfJQ512UU75o4CzMesuJktjUaBu
lb0leslFpiQvz7HtCi2NOJc4BTqsDdraI/q8YPjY7uKlzSbUsxdoaxxqRgDKYaka
wSLGBHEpTlPemFyFqm40aOU=
-----END PRIVATE KEY-----\n`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUZF9lpudMIpp0Vus+xdqJAI/noZYwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MDkxMDIzMzMxNFoXDTM2MDkw
NzIzMzMxNFowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAqwm3I/22akq8IpP01gBuMF4ukiwohrOaIJy7aOhsBD4p
AiOchskxv9TQPvSmAr+sA6CSRdTjlokPPLYuYBjnXLfp/8+gTrKbVPnVKZO4N27C
f9jvvEmZEPgXBXcVd5OQ0Oyz5+SDWdBReZycfd6O1gx98BgcKpJbBqDFe6QOBjlf
DnZksoxfSOS3v+VNlwBpIKekhZNbW9XzBtYgjvnhkoK49G+D7qmVmTW/LLApwXeA
qh+krthst5mMicK5q938fj8Quhfa7Id5GnI+5N2DsLFzmvYRI9ypAnxDLujoFrhP
ye93OkbUuFa+ZaejdxpeRclqrlQsSwrKirv7Vkd0SwIDAQABo1MwUTAdBgNVHQ4E
FgQUZTVhiyKItIojnct2l22yBSV6IbIwHwYDVR0jBBgwFoAUZTVhiyKItIojnct2
l22yBSV6IbIwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAgFq0
LyrSPRrUK7HJ/P4AXOcm8u05Kdefo4UvuS8X61d4FJOntVl2tdeDvWeysHjokzKZ
IT2AwWoOMaIgvfmEnu3htvBlJBXA64aSuvIO6Y1Xfc8B1l3tZ29c1PL7XoF3nvNs
YdwBxOSSWle0e3I8INI7Q1b/lMsIP1L1p0PdiqVC0HPYgUOeBwWPtlHQTwy/fUxs
aPw2bv5Cdja+0RcIZKD39zrWq7tadlEwVjpZCaWsy3BCvbN3Lh3+falflY36ogbf
8TtaoEOvM/7+s23APCLvQsVV21ZvVCWNammbVBjakUNSvorD7ismH+ri34HZdqpJ
2DScSz6vFgmg28dQCA==
-----END CERTIFICATE-----\n`;

test("disabled TLS does not provide HTTPS server options", async () => {
  const tls = await prepareHttpTls({ mode: "off" });
  await tls.start();
  assert.equal(tls.mode, "off");
  assert.equal(tls.getServerOptions(), undefined);
  assert.equal(tls.isAvailable(), true);
  await tls.close();
});

test("manual TLS fails before opening a server for missing files", async () => {
  const tls = await prepareHttpTls({
    mode: "manual",
    certPath: "/tmp/llm-chess-mcp-missing-certificate.pem",
    keyPath: "/tmp/llm-chess-mcp-missing-private-key.pem",
  });
  await assert.rejects(tls.start(), /ENOENT/);
  await tls.close();
});

test("manual TLS creates a working HTTPS handshake", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  await writeFile(certPath, TEST_CERT, { mode: 0o600 });
  await writeFile(keyPath, TEST_KEY, { mode: 0o600 });
  const tls = await prepareHttpTls({ mode: "manual", certPath, keyPath });
  const server = createHttpsServer(tls.getServerOptions() ?? {}, (_req, res) => res.end("ok"));
  try {
    await tls.start();
    server.setSecureContext(tls.getServerOptions()!);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      const request = httpsGet({ hostname: "127.0.0.1", port, rejectUnauthorized: false }, (response) => {
        let value = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { value += chunk; });
        response.on("end", () => resolve(value));
      });
      request.once("error", reject);
    });
    assert.equal(body, "ok");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await tls.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("serveHttp uses HTTPS, authentication, and the TLS availability gate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-http-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  await writeFile(certPath, TEST_CERT, { mode: 0o600 });
  await writeFile(keyPath, TEST_KEY, { mode: 0o600 });
  const server = await serveHttp({
    host: "127.0.0.1",
    port: 0,
    headersTimeoutMs: 500,
    auth: { bearer: "tls-http-test" },
    tls: { mode: "manual", certPath, keyPath },
  });
  try {
    assert.match(server.url, /^https:\/\//);
    const endpoint = new URL(server.url);
    const request = (authorization?: string) => new Promise<number>((resolve, reject) => {
      const client = httpsGet({ hostname: endpoint.hostname, port: endpoint.port, path: endpoint.pathname, rejectUnauthorized: false, ...(authorization ? { headers: { authorization } } : {}) }, (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
      });
      client.once("error", reject);
    });
    assert.equal(await request(), 401);
    assert.equal(await request("Bearer tls-http-test"), 400);
    for (const encrypted of [false, true]) {
      await new Promise<void>((resolve, reject) => {
        let connected = false;
        const address = { host: endpoint.hostname, port: Number(endpoint.port) };
        const socket = encrypted ? connectTls({ ...address, rejectUnauthorized: false }) : connect(address);
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("TLS handshake/header deadline did not close the connection"));
        }, 5_000);
        socket.once(encrypted ? "secureConnect" : "connect", () => {
          connected = true;
          if (encrypted) socket.write("GET /mcp HTTP/1.1\r\nHost:");
        });
        socket.on("error", () => {});
        socket.once("close", () => {
          clearTimeout(timer);
          if (connected) resolve();
          else reject(new Error("TLS test connection failed before reaching the server"));
        });
      });
    }
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("HTTP shutdown reports ACME lock cleanup failures", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-close-permissions-"));
  await writeFile(join(dir, "certificate-bundle.json"), JSON.stringify({
    domain: "localhost", directoryUrl: "https://acme-v02.api.letsencrypt.org/directory", cert: TEST_CERT, key: TEST_KEY,
  }));
  const http = await serveHttp({ port: 0, tls: {
    mode: "acme", domain: "localhost", email: "ops@example.com", storageDir: dir, termsOfServiceAgreed: true,
  } });
  try {
    await chmod(dir, 0o500);
    await assert.rejects(http.close(), { code: "EACCES" });
    await chmod(dir, 0o700);
    await stat(join(dir, "issue.lock"));
  } finally {
    await chmod(dir, 0o700);
    await http.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME startup retains both issuance and lock cleanup errors", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "acme-startup-permissions-"));
  const issuanceError = new Error("client loading failed");
  const tls = await prepareHttpTls({
    mode: "acme", domain: "localhost", email: "ops@example.com", storageDir: dir,
    termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0,
  }, { loadAcme: async () => {
    await chmod(dir, 0o500);
    throw issuanceError;
  } });
  try {
    await assert.rejects(tls.start(), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.errors[0], issuanceError);
      assert.equal((error.errors[1] as NodeJS.ErrnoException).code, "EACCES");
      return true;
    });
    await chmod(dir, 0o700);
    await tls.close();
    await stat(join(dir, "issue.lock"));
  } finally {
    await chmod(dir, 0o700);
    await tls.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME validates the domain and terms before touching storage", async () => {
  const tls = await prepareHttpTls({
    mode: "acme",
    domain: "Example.com",
    email: "operator@example.com",
    storageDir: "/tmp/llm-chess-mcp-acme-test",
    termsOfServiceAgreed: true,
  });
  await assert.rejects(tls.start(), /lowercase/);
  await tls.close();
});

for (const challengeHost of ["127.0.0.1", "::1"]) test(`ACME issues and reuses its bundle over ${challengeHost}`, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-acme-"));
  let challengeServer: Server | undefined;
  let issueCount = 0;
  const loadAcme = async (): Promise<unknown> => ({
    crypto: {
      createPrivateRsaKey: async () => "account-key",
      createCsr: async () => [TEST_KEY, "csr"],
    },
    Client: class {
      constructor(_options: unknown) {}
      async auto(options: {
        challengeCreateFn: (authz: { identifier: { value: string } }, challenge: { token: string }, keyAuthorization: string) => Promise<void>;
        challengeRemoveFn: (authz: { identifier: { value: string } }, challenge: { token: string }, keyAuthorization: string) => Promise<void>;
      }): Promise<string> {
        issueCount += 1;
        const authz = { identifier: { value: "localhost" } };
        const challenge = { token: "token-for-test" };
        await options.challengeCreateFn(authz, challenge, "token-for-test.key");
        const address = challengeServer?.address() as AddressInfo;
        const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
          const request = httpGet({ hostname: challengeHost, port: address.port, path: `/.well-known/acme-challenge/${challenge.token}`, headers: { host: "localhost" } }, (result) => {
            let body = "";
            result.setEncoding("utf8");
            result.on("data", (chunk: string) => { body += chunk; });
            result.on("end", () => resolve({ status: result.statusCode, body }));
          });
          request.once("error", reject);
        });
        assert.equal(response.status, 200);
        assert.equal(response.body, "token-for-test.key");
        await options.challengeRemoveFn(authz, challenge, "token-for-test.key");
        return TEST_CERT;
      }
    },
  });
  const options = {
    mode: "acme" as const,
    domain: "localhost",
    email: "operator@example.com",
    storageDir: dir,
    termsOfServiceAgreed: true as const,
    challengePort: 0,
    operationTimeoutMs: 5_000,
  };
  const deps = { loadAcme, createChallengeServer: (handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) => {
    challengeServer = createServer(handler);
    return challengeServer;
  } };
  const resolved = resolveHttpConfig({ host: challengeHost, port: 0, tls: options });
  const first = await prepareHttpTls(resolved.tls, deps);
  const second = await prepareHttpTls(options, deps);
  try {
    try {
      await first.start();
    } catch (error) {
      if (challengeHost === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        t.skip("IPv6 loopback is unavailable");
        return;
      }
      throw error;
    }
    assert.equal(first.isAvailable(), true);
    assert.equal(issueCount, 1);
    const bundle = JSON.parse(await readFile(join(dir, "certificate-bundle.json"), "utf8")) as { cert: string; key: string };
    assert.equal(bundle.cert, TEST_CERT);
    assert.equal(bundle.key, TEST_KEY);
    await assert.rejects(second.start(), /locked/);
    await first.close();
    await second.start();
    assert.equal(issueCount, 1);
  } finally {
    await first.close();
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME requires explicit terms agreement", async () => {
  const tls = await prepareHttpTls({
    mode: "acme",
    domain: "example.com",
    email: "operator@example.com",
    storageDir: "/tmp/llm-chess-mcp-acme-test",
    termsOfServiceAgreed: false as true,
  });
  await assert.rejects(tls.start(), /Terms of Service/);
  await tls.close();
});

test("ACME keeps a usable certificate after a renewal failure and recovers on retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-renewal-"));
  const expiresAt = Date.parse(new X509Certificate(TEST_CERT).validTo);
  let now = expiresAt - 5_000;
  let issueCount = 0;
  let challengeServer: Server | undefined;
  const loadAcme = async (): Promise<unknown> => ({
    crypto: { createPrivateRsaKey: async () => "account-key", createCsr: async () => [TEST_KEY, "csr"] },
    Client: class {
      constructor(_options: unknown) {}
      async auto(options: { challengeCreateFn: (a: { identifier: { value: string } }, c: { token: string }, k: string) => Promise<void>; challengeRemoveFn: (a: { identifier: { value: string } }, c: { token: string }, k: string) => Promise<void> }): Promise<string> {
        issueCount += 1;
        const authz = { identifier: { value: "localhost" } };
        const challenge = { token: `renew-${issueCount}` };
        await options.challengeCreateFn(authz, challenge, `${challenge.token}.key`);
        await options.challengeRemoveFn(authz, challenge, `${challenge.token}.key`);
        if (issueCount === 1) throw new Error("temporary CA failure");
        return TEST_CERT;
      }
    },
  });
  await writeFile(join(dir, "certificate-bundle.json"), JSON.stringify({ domain: "localhost", directoryUrl: "https://acme-v02.api.letsencrypt.org/directory", cert: TEST_CERT, key: TEST_KEY }), { mode: 0o600 });
  await writeFile(join(dir, "account-key.pem"), "account-key", { mode: 0o600 });
  const tls = await prepareHttpTls({ mode: "acme", domain: "localhost", email: "operator@example.com", storageDir: dir, termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0, operationTimeoutMs: 1_000 }, {
    now: () => now,
    loadAcme,
    createChallengeServer: (handler) => {
      challengeServer = createServer(handler);
      return challengeServer;
    },
  });
  const availability: boolean[] = [];
  tls.onAvailability((value) => availability.push(value));
  try {
    await tls.start();
    assert.equal(tls.isAvailable(), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(issueCount, 1);
    now = expiresAt - 100;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(issueCount, 2);
    assert.equal(tls.isAvailable(), true);
    now = expiresAt + 1;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(tls.isAvailable(), false);
    assert.deepEqual(availability, [true, false]);
  } finally {
    await tls.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ACME timeout does not make close wait for an uncooperative client", async () => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-mcp-timeout-"));
  let challengeServer: Server | undefined;
  const tls = await prepareHttpTls({ mode: "acme", domain: "example.com", email: "operator@example.com", storageDir: dir, termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0, operationTimeoutMs: 20 }, {
    loadAcme: async () => ({
      crypto: { createPrivateRsaKey: async () => "account-key", createCsr: async () => [TEST_KEY, "csr"] },
      Client: class {
        constructor(_options: unknown) {}
        auto(_options: unknown): Promise<string> { return new Promise(() => undefined); }
      },
    }),
    createChallengeServer: (handler) => {
      challengeServer = createServer(handler);
      return challengeServer;
    },
  });
  try {
    await assert.rejects(tls.start(), /timed out/);
    const started = Date.now();
    await tls.close();
    assert.ok(Date.now() - started < 500);
    assert.equal(tls.isAvailable(), false);
  } finally {
    await tls.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("closing during ACME startup drains initialization and releases its lock", { timeout: 5_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-acme-start-close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => { entered = resolve; });
  const tls = await prepareHttpTls({
    mode: "acme", domain: "localhost", email: "operator@example.com", storageDir: dir,
    termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0,
  }, { loadAcme: () => { entered(); return new Promise(() => {}); } });
  t.after(() => tls.close());
  const rejected = assert.rejects(tls.start(), /cancelled|closed/);
  await loading;
  await tls.close();
  await rejected;
  assert.equal(tls.isAvailable(), false);
  await assert.rejects(stat(join(dir, "issue.lock")), { code: "ENOENT" });
});

test("ACME close aborts the real callable Axios instance's network request", { timeout: 5_000 }, async (t) => {
  const acme = await import("acme-client");
  assert.equal(typeof acme.axios, "function");
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-acme-network-close-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let received!: () => void;
  let disconnected!: () => void;
  const receiving = new Promise<void>((resolve) => { received = resolve; });
  const disconnecting = new Promise<void>((resolve) => { disconnected = resolve; });
  const ca = createServer((req) => {
    req.once("close", disconnected);
    received();
  });
  await new Promise<void>((resolve) => ca.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    ca.closeAllConnections();
    await new Promise<void>((resolve) => ca.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(ca.address() as AddressInfo).port}/order`;
  const tls = await prepareHttpTls({
    mode: "acme", domain: "localhost", email: "operator@example.com", storageDir: dir,
    termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0,
  }, { loadAcme: async () => ({
    axios: acme.axios,
    crypto: { createPrivateRsaKey: async () => "account", createCsr: async () => [TEST_KEY, "csr"] },
    Client: class { async auto(): Promise<string> { await acme.axios.get(url); return TEST_CERT; } },
  }) });
  t.after(() => tls.close());
  const rejected = assert.rejects(tls.start());
  await receiving;
  await tls.close();
  await rejected;
  await disconnecting;
  await assert.rejects(stat(join(dir, "certificate-bundle.json")), { code: "ENOENT" });
});

test("ACME polling cancellation stops the installed client's retry timer", { timeout: 5_000 }, async () => {
  const acme = await import("acme-client");
  const pollingClient = new acme.Client({ directoryUrl: "http://127.0.0.1/unused", accountKey: "unused", backoffAttempts: 1 }) as unknown as AcmeClient;
  const statuses = ["pending", "valid"];
  let pollingAttempts = 0;
  pollingClient.api!.apiRequest = async () => {
    pollingAttempts += 1;
    return { data: { status: statuses.shift() } };
  };
  installAcmeAbortPolling(pollingClient, new AbortController().signal, { attempts: 3, min: 1, max: 1 });
  assert.deepEqual(await pollingClient.waitForValidStatus!({ url: "http://127.0.0.1/unused" }), { status: "valid" });
  assert.equal(pollingAttempts, 2);

  const invalidClient = new acme.Client({ directoryUrl: "http://127.0.0.1/unused", accountKey: "unused", backoffAttempts: 1 }) as unknown as AcmeClient;
  let invalidAttempts = 0;
  invalidClient.api!.apiRequest = async () => {
    invalidAttempts += 1;
    return { data: { status: "invalid", detail: "certificate rejected\n" } };
  };
  installAcmeAbortPolling(invalidClient, new AbortController().signal, { attempts: 3, min: 1, max: 1 });
  await assert.rejects(invalidClient.waitForValidStatus!({ url: "http://127.0.0.1/unused" }), /certificate rejected/);
  assert.equal(invalidAttempts, 1);

  const lateClient = new acme.Client({ directoryUrl: "http://127.0.0.1/unused", accountKey: "unused", backoffAttempts: 1 }) as unknown as AcmeClient;
  const lateAbort = new AbortController();
  lateClient.api!.apiRequest = async () => {
    lateAbort.abort();
    return { data: { status: "valid" } };
  };
  installAcmeAbortPolling(lateClient, lateAbort.signal);
  await assert.rejects(lateClient.waitForValidStatus!({ url: "http://127.0.0.1/unused" }), { name: "AbortError" });

  const client = new acme.Client({ directoryUrl: "http://127.0.0.1/unused", accountKey: "unused", backoffAttempts: 1 }) as unknown as AcmeClient;
  const controller = new AbortController();
  let attempts = 0;
  client.api!.apiRequest = async () => {
    attempts += 1;
    return { data: { status: "pending" } };
  };
  installAcmeAbortPolling(client, controller.signal, { attempts: 3, min: 1_000, max: 1_000 });
  const pending = client.waitForValidStatus!({ url: "http://127.0.0.1/unused" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("ACME challenge verification retries normally and cancels its retry delay", { timeout: 5_000 }, async (t) => {
  const acme = await import("acme-client");
  let attempts = 0;
  let valid = true;
  t.mock.method(acme.axios, "get", async () => ({
    data: ++attempts > 1 && valid ? "token.thumbprint" : "not-ready",
  }));
  const makeClient = (): AcmeClient => {
    const client = new acme.Client({ directoryUrl: "http://127.0.0.1/unused", accountKey: "unused", backoffAttempts: 1 });
    client.getChallengeKeyAuthorization = async () => "token.thumbprint";
    return client as unknown as AcmeClient;
  };
  const authz = { url: "http://127.0.0.1/authz", identifier: { value: "localhost" } };
  const challenge = { url: "http://127.0.0.1/challenge", type: "http-01", token: "token" };
  const normal = makeClient();
  installAcmeAbortPolling(normal, new AbortController().signal, { attempts: 3, min: 1, max: 1 });
  await normal.verifyChallenge!(authz, challenge);
  assert.equal(attempts, 2);
  await assert.rejects(normal.verifyChallenge!({}, challenge), /URL not found/);
  await assert.rejects(normal.verifyChallenge!(authz, { ...challenge, type: "unsupported" }), /unknown type/);
  assert.equal(attempts, 2);

  attempts = 0;
  valid = false;
  const cancelled = makeClient();
  const controller = new AbortController();
  installAcmeAbortPolling(cancelled, controller.signal, { attempts: 3, min: 1_000, max: 1_000 });
  const pending = cancelled.verifyChallenge!(authz, challenge);
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("ACME never serves or persists a certificate for a different domain", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "llm-chess-acme-domain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const tls = await prepareHttpTls({
    mode: "acme", domain: "wrong.example.com", email: "operator@example.com", storageDir: dir,
    termsOfServiceAgreed: true, challengeHost: "127.0.0.1", challengePort: 0,
  }, { loadAcme: async () => ({
    crypto: { createPrivateRsaKey: async () => "account", createCsr: async () => [TEST_KEY, "csr"] },
    Client: class { async auto(): Promise<string> { return TEST_CERT; } },
  }) });
  t.after(() => tls.close());
  await assert.rejects(tls.start(), /does not match/);
  assert.equal(tls.isAvailable(), false);
  await assert.rejects(stat(join(dir, "certificate-bundle.json")), { code: "ENOENT" });
});
