import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { SecureContext } from "node:tls";
import { isIP } from "node:net";
import {
  acmeAbortStorage,
  installAcmeAbortPolling,
  installAcmeAbortInterceptor,
  loadAcme as defaultLoadAcme,
  unwrapAcmeModule as unwrapModule,
} from "./http-tls-acme.js";
import {
  validateCertificate,
  type HttpTlsServerOptions,
  type TlsCertificate,
} from "./http-tls-cert.js";
import { AcmeStorageLock, writePrivateFile } from "./http-tls-storage.js";
import { failAfterCleanup } from "./lifecycle.js";

const DEFAULT_DIRECTORY_URL =
  "https://acme-v02.api.letsencrypt.org/directory";
const DEFAULT_CHALLENGE_HOST = "0.0.0.0";
const DEFAULT_CHALLENGE_PORT = 80;
const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type HttpTlsOptions =
  | { mode: "off" }
  | { mode: "manual"; certPath: string; keyPath: string }
  | {
      mode: "acme";
      domain: string;
      email: string;
      storageDir: string;
      termsOfServiceAgreed: true;
      directoryUrl?: string;
      challengeHost?: string;
      challengePort?: number;
      operationTimeoutMs?: number;
    };

export type { HttpTlsServerOptions } from "./http-tls-cert.js";

export type HttpTlsDependencies = {
  now?: () => number;
  loadAcme?: () => Promise<unknown>;
  createChallengeServer?: (handler: (req: IncomingMessage, res: ServerResponse) => void) => Server;
};

export type HttpTlsController = {
  readonly mode: HttpTlsOptions["mode"];
  readonly certificateExpiresAt: number | undefined;
  getServerOptions(): HttpTlsServerOptions | undefined;
  isAvailable(): boolean;
  start(): Promise<void>;
  onSecureContext(listener: (options: HttpTlsServerOptions) => void): () => void;
  onAvailability(listener: (available: boolean) => void): () => void;
  close(): Promise<void>;
};

type ListenerSet<T> = Set<(value: T) => void>;

function positiveTimer(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`${name} must be a safe integer between 1 and ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

function assertText(name: string, value: string): void {
  if (!value || value.trim() !== value || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
}

export function snapshotHttpTlsOptions(options: HttpTlsOptions): HttpTlsOptions {
  if (options.mode === "manual") {
    assertText("TLS certificate path", options.certPath);
    assertText("TLS private key path", options.keyPath);
    return { mode: "manual", certPath: resolve(options.certPath), keyPath: resolve(options.keyPath) };
  }
  if (options.mode === "acme") {
    assertText("ACME storage directory", options.storageDir);
    return {
      mode: "acme",
      domain: options.domain,
      email: options.email,
      storageDir: resolve(options.storageDir),
      termsOfServiceAgreed: options.termsOfServiceAgreed,
      ...(options.directoryUrl === undefined ? {} : { directoryUrl: options.directoryUrl }),
      ...(options.challengeHost === undefined ? {} : { challengeHost: options.challengeHost }),
      ...(options.challengePort === undefined ? {} : { challengePort: options.challengePort }),
      ...(options.operationTimeoutMs === undefined ? {} : { operationTimeoutMs: options.operationTimeoutMs }),
    };
  }
  return { mode: options.mode };
}

function validateAcmeDomain(domain: string): void {
  assertText("ACME domain", domain);
  if (isIP(domain) || domain.length > 253 || domain.includes("/") || domain.includes(":")) {
    throw new Error("ACME domain must be a DNS hostname");
  }
  if (domain !== domain.toLowerCase() || domain.endsWith(".")) {
    throw new Error("ACME domain must be lowercase and without a trailing dot");
  }
  for (const label of domain.split(".")) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error("invalid ACME domain");
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        onAbort = () => reject(new Error(`${label} cancelled`));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(`${label} timed out`));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
}

class TlsController implements HttpTlsController {
  readonly mode: HttpTlsOptions["mode"];
  private context: SecureContext | undefined;
  private currentServerOptions: HttpTlsServerOptions | undefined;
  private expires: number | undefined;
  private available = false;
  private started = false;
  private closed = false;
  private startPromise: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly lifecycle = new AbortController();
  private renewalTimer: NodeJS.Timeout | undefined;
  private renewalDeadline: number | undefined;
  private renewalBackoffMs = 1_000;
  private expiryTimer: NodeJS.Timeout | undefined;
  private challengeServer: Server | undefined;
  private readonly storageLock = new AcmeStorageLock();
  private issuePromise: Promise<TlsCertificate> | undefined;
  private issueGeneration = 0;
  private activeIssueGeneration = 0;
  private readonly issueAbortControllers = new Map<number, AbortController>();
  private readonly pendingWrites = new Set<Promise<void>>();
  private readonly challenges = new Map<string, { domain: string; value: string }>();
  private readonly contextListeners: ListenerSet<HttpTlsServerOptions> = new Set();
  private readonly availabilityListeners: ListenerSet<boolean> = new Set();
  private readonly now: () => number;
  private readonly loadAcme: () => Promise<unknown>;
  private readonly createChallengeServer: NonNullable<HttpTlsDependencies["createChallengeServer"]>;
  private readonly options: HttpTlsOptions;

  constructor(options: HttpTlsOptions, dependencies: HttpTlsDependencies = {}) {
    this.options = snapshotHttpTlsOptions(options);
    this.mode = options.mode;
    this.now = dependencies.now ?? Date.now;
    this.loadAcme = dependencies.loadAcme ?? defaultLoadAcme;
    this.createChallengeServer = dependencies.createChallengeServer ?? ((handler) => createServer(handler));
  }

  get certificateExpiresAt(): number | undefined {
    return this.expires;
  }

  getServerOptions(): HttpTlsServerOptions | undefined {
    if (!this.context || this.options.mode === "off") return undefined;
    return this.currentServerOptions;
  }

  isAvailable(): boolean {
    if (this.expires !== undefined && this.now() >= this.expires) this.markUnavailable();
    return this.available;
  }

  onSecureContext(listener: (options: HttpTlsServerOptions) => void): () => void {
    this.contextListeners.add(listener);
    return () => this.contextListeners.delete(listener);
  }

  onAvailability(listener: (available: boolean) => void): () => void {
    this.availabilityListeners.add(listener);
    return () => this.availabilityListeners.delete(listener);
  }

  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("TLS controller is closed"));
    if (!this.startPromise) {
      const promise = this.startInternal();
      this.startPromise = promise;
      void promise.catch(() => {
        if (this.startPromise === promise) this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    if (this.closed) throw new Error("TLS controller is closed");
    if (this.started) return;
    this.started = true;
    if (this.mode === "off") {
      this.available = true;
      return;
    }
    if (this.mode === "manual") {
      const options = this.options;
      if (options.mode !== "manual") throw new Error("invalid manual TLS configuration");
      try {
        const [cert, key] = await Promise.all([readFile(options.certPath, "utf8"), readFile(options.keyPath, "utf8")]);
        this.setCertificate(validateCertificate(cert, key, this.now()));
      } catch (error) {
        this.started = false;
        throw error;
      }
      return;
    }
    try {
      await this.startAcme();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  private setCertificate(certificate: TlsCertificate): void {
    if (this.closed) throw new Error("TLS controller is closed");
    this.context = certificate.context;
    this.currentServerOptions = certificate.serverOptions;
    this.expires = certificate.expiresAt;
    const wasAvailable = this.available;
    this.available = true;
    this.scheduleExpiry(certificate.expiresAt);
    for (const listener of this.contextListeners) listener(certificate.serverOptions);
    if (!wasAvailable) for (const listener of this.availabilityListeners) listener(true);
  }

  private markUnavailable(): void {
    if (!this.available) return;
    this.available = false;
    for (const listener of this.availabilityListeners) listener(false);
  }

  private async startAcme(): Promise<void> {
    const options = this.options;
    if (options.mode !== "acme") return;
    validateAcmeDomain(options.domain);
    assertText("ACME email", options.email);
    if (!options.email.includes("@") || options.email.includes(" ")) throw new Error("invalid ACME email");
    if (options.termsOfServiceAgreed !== true) throw new Error("ACME Terms of Service agreement is required");
    const operationTimeoutMs = positiveTimer("operationTimeoutMs", options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
    const challengePort = options.challengePort ?? DEFAULT_CHALLENGE_PORT;
    if (!Number.isInteger(challengePort) || challengePort < 0 || challengePort > 65_535) throw new RangeError("invalid ACME challenge port");
    assertText("ACME storage directory", options.storageDir);
    const storageDir = options.storageDir;
    await mkdir(storageDir, { recursive: true, mode: 0o700 });
    await this.storageLock.acquire(storageDir);
    if (this.closed) {
      return failAfterCleanup(new Error("TLS controller is closed"), () => this.storageLock.release(storageDir), "ACME startup cancellation and lock cleanup failed");
    }
    const paths = {
      bundle: join(storageDir, "certificate-bundle.json"),
      account: join(storageDir, "account-key.pem"),
    };
    let existing: TlsCertificate | undefined;
    try {
      existing = await this.readExisting(paths, options);
    } catch (error) {
      return failAfterCleanup(error, () => this.storageLock.release(storageDir), "ACME certificate loading and lock cleanup failed");
    }
    if (this.closed) {
      return failAfterCleanup(new Error("TLS controller is closed"), () => this.storageLock.release(storageDir), "ACME startup cancellation and lock cleanup failed");
    }
    if (existing && existing.expiresAt > this.now()) {
      this.setCertificate(existing);
      this.scheduleRenewal(Math.max(0, existing.renewAt - this.now()));
      return;
    }
    try {
      const issued = await this.issue(paths, options, challengePort, operationTimeoutMs);
      this.setCertificate(issued);
      this.renewalBackoffMs = 1_000;
      this.scheduleRenewal(Math.max(1_000, issued.renewAt - this.now()));
    } catch (error) {
      if (!existing || existing.expiresAt <= this.now()) this.markUnavailable();
      else {
        this.scheduleRenewal(this.renewalBackoffMs);
        this.renewalBackoffMs = Math.min(3_600_000, this.renewalBackoffMs * 2);
        console.error("ACME certificate renewal failed; serving the existing certificate", error);
        return;
      }
      return failAfterCleanup(error, () => this.storageLock.release(storageDir), "ACME issuance and lock cleanup failed");
    }
  }

  private async readExisting(paths: { bundle: string }, options: Extract<HttpTlsOptions, { mode: "acme" }>): Promise<TlsCertificate | undefined> {
    try {
      const raw = JSON.parse(await readFile(paths.bundle, "utf8")) as { domain?: unknown; directoryUrl?: unknown; cert?: unknown; key?: unknown };
      if (raw.domain !== options.domain || raw.directoryUrl !== (options.directoryUrl ?? DEFAULT_DIRECTORY_URL)) return undefined;
      if (typeof raw.cert !== "string" || typeof raw.key !== "string") throw new Error("invalid TLS certificate bundle");
      const cert = raw.cert;
      const key = raw.key;
      try { return validateCertificate(cert, key, this.now(), options.domain); }
      catch { return undefined; }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeTracked(path: string, data: string, generation: number): Promise<void> {
    this.ensureIssueActive(generation);
    const operation = writePrivateFile(path, data);
    this.pendingWrites.add(operation);
    try {
      await operation;
    } finally {
      this.pendingWrites.delete(operation);
    }
  }

  private async issue(
    paths: { bundle: string; account: string },
    options: Extract<HttpTlsOptions, { mode: "acme" }>,
    challengePort: number,
    operationTimeoutMs: number,
  ): Promise<TlsCertificate> {
    if (this.issuePromise) return this.issuePromise;
    const generation = ++this.issueGeneration;
    this.activeIssueGeneration = generation;
    this.issuePromise = this.issueInternal(paths, options, challengePort, operationTimeoutMs, generation);
    try {
      return await this.issuePromise;
    } finally {
      if (this.activeIssueGeneration === generation) this.activeIssueGeneration = 0;
      this.issuePromise = undefined;
    }
  }

  private async issueInternal(
    paths: { bundle: string; account: string },
    options: Extract<HttpTlsOptions, { mode: "acme" }>,
    challengePort: number,
    operationTimeoutMs: number,
    generation: number,
  ): Promise<TlsCertificate> {
    try {
      await this.openChallengeServer(options.challengeHost ?? DEFAULT_CHALLENGE_HOST, challengePort);
      const acme = unwrapModule(await withTimeout(this.loadAcme(), operationTimeoutMs, "ACME client loading", undefined, this.lifecycle.signal));
      installAcmeAbortInterceptor(acme);
      this.ensureIssueActive(generation);
      let accountKey: string;
      try {
        accountKey = await readFile(paths.account, "utf8");
        if (!accountKey || accountKey.includes("\0")) throw new Error("invalid ACME account key");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        accountKey = String(await withTimeout(acme.crypto.createPrivateRsaKey(), operationTimeoutMs, "ACME account key generation", () => this.invalidateIssue(generation), this.lifecycle.signal));
        this.ensureIssueActive(generation);
        await this.writeTracked(paths.account, accountKey, generation);
      }
      this.ensureIssueActive(generation);
      const [privateKeyRaw, csrRaw] = await withTimeout(acme.crypto.createCsr({ altNames: [options.domain] }), operationTimeoutMs, "ACME CSR generation", () => this.invalidateIssue(generation), this.lifecycle.signal);
      this.ensureIssueActive(generation);
      const privateKey = Buffer.isBuffer(privateKeyRaw) ? privateKeyRaw.toString("utf8") : String(privateKeyRaw);
      const csr = Buffer.isBuffer(csrRaw) ? csrRaw : String(csrRaw);
      // acme-client's retry timer cannot be cancelled; polling is wrapped below.
      const client = new acme.Client({ directoryUrl: options.directoryUrl ?? DEFAULT_DIRECTORY_URL, accountKey, backoffAttempts: 1 });
      const abortController = new AbortController();
      this.issueAbortControllers.set(generation, abortController);
      installAcmeAbortPolling(client, abortController.signal);
      const certificateOperation = acmeAbortStorage.run(abortController.signal, () => client.auto({
        csr,
        email: options.email,
        termsOfServiceAgreed: true,
        challengePriority: ["http-01"],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => this.createChallenge(generation, authz, challenge, keyAuthorization),
        challengeRemoveFn: async (authz, challenge) => this.removeChallenge(generation, authz, challenge),
      }));
      const certificate = await withTimeout(certificateOperation, operationTimeoutMs, "ACME certificate issuance", () => {
        this.invalidateIssue(generation);
        abortController.abort();
      }, this.lifecycle.signal);
      this.issueAbortControllers.delete(generation);
      this.ensureIssueActive(generation);
      const cert = String(certificate);
      const validated = validateCertificate(cert, privateKey, this.now(), options.domain);
      this.ensureIssueActive(generation);
      await this.writeTracked(paths.bundle, JSON.stringify({ domain: options.domain, directoryUrl: options.directoryUrl ?? DEFAULT_DIRECTORY_URL, cert, key: privateKey }), generation);
      return validated;
    } finally {
      this.issueAbortControllers.get(generation)?.abort();
      this.issueAbortControllers.delete(generation);
      this.challenges.clear();
      await this.closeChallengeServer();
    }
  }

  private async openChallengeServer(host: string, port: number): Promise<void> {
    if (this.challengeServer) return;
    const server = this.createChallengeServer((req, res) => this.handleChallenge(req, res));
    server.maxConnections = 32;
    server.maxHeadersCount = 32;
    server.headersTimeout = 10_000;
    server.requestTimeout = 10_000;
    server.timeout = 10_000;
    server.keepAliveTimeout = 1_000;
    server.on("connection", (socket) => socket.setTimeout(10_000, () => socket.destroy()));
    try {
      await listen(server, port, host);
    } catch (error) {
      server.closeAllConnections?.();
      server.close();
      throw error;
    }
    this.challengeServer = server;
  }

  private async closeChallengeServer(): Promise<void> {
    const server = this.challengeServer;
    this.challengeServer = undefined;
    if (server) {
      server.closeAllConnections?.();
      await closeServer(server).catch(() => undefined);
    }
  }

  private handleChallenge(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET" || !req.url) {
      res.writeHead(404).end();
      return;
    }
    const match = /^\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{1,256})$/.exec(req.url);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const token = match[1];
    if (!token) {
      res.writeHead(404).end();
      return;
    }
    const challenge = this.challenges.get(token);
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!challenge || host !== challenge.domain) {
      res.writeHead(404).end();
      return;
    }
    const body = challenge.value;
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    }).end(body);
  }

  private ensureIssueActive(generation: number): void {
    if (this.closed || this.activeIssueGeneration !== generation) {
      throw new Error("ACME operation is no longer active");
    }
  }

  private invalidateIssue(generation: number): void {
    if (this.activeIssueGeneration === generation) this.activeIssueGeneration = 0;
  }

  private createChallenge(generation: number, authz: { identifier?: { value?: string } }, challenge: { token?: string }, keyAuthorization: string): Promise<void> {
    this.ensureIssueActive(generation);
    const domain = authz.identifier?.value;
    const token = challenge.token;
    if (!domain || !token || !/^[A-Za-z0-9_-]{1,256}$/.test(token) || keyAuthorization.length > 2_048 || domain !== (this.options.mode === "acme" ? this.options.domain : "")) throw new Error("invalid ACME HTTP-01 challenge");
    this.challenges.set(token, { domain, value: keyAuthorization });
    return Promise.resolve();
  }

  private removeChallenge(generation: number, _authz: { identifier?: { value?: string } }, challenge: { token?: string }): Promise<void> {
    if (this.activeIssueGeneration !== generation || this.closed) return Promise.resolve();
    if (challenge.token) this.challenges.delete(challenge.token);
    return Promise.resolve();
  }

  private scheduleRenewal(delayMs: number): void {
    if (this.closed) return;
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalDeadline = this.now() + delayMs;
    const deadline = this.renewalDeadline;
    const schedule = (): void => {
      if (this.closed || this.renewalDeadline !== deadline) return;
      const remaining = deadline - this.now();
      if (remaining > 0) {
        this.renewalTimer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
        this.renewalTimer.unref();
        return;
      }
      this.renewalTimer = undefined;
      void this.renew().catch((error: unknown) => console.error("ACME certificate renewal failed", error));
    };
    this.renewalTimer = setTimeout(schedule, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    this.renewalTimer.unref();
  }

  private scheduleExpiry(expiresAt: number): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const delay = Math.max(1_000, Math.min(MAX_TIMER_DELAY_MS, expiresAt - this.now() + 1));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      if (this.now() >= expiresAt) this.markUnavailable();
      else this.scheduleExpiry(expiresAt);
    }, delay);
    this.expiryTimer.unref();
  }

  private async renew(): Promise<void> {
    if (this.closed || this.mode !== "acme" || !this.expires) return;
    const options = this.options;
    if (options.mode !== "acme") return;
    try {
      const issued = await this.issue({ bundle: join(options.storageDir, "certificate-bundle.json"), account: join(options.storageDir, "account-key.pem") }, options, options.challengePort ?? DEFAULT_CHALLENGE_PORT, options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
      if (!this.closed) {
        this.setCertificate(issued);
        this.renewalBackoffMs = 1_000;
        this.scheduleRenewal(Math.max(1_000, issued.renewAt - this.now()));
      }
    } catch (error) {
      const expires = this.expires;
      if (expires !== undefined && expires <= this.now()) {
        this.markUnavailable();
        this.scheduleRenewal(60_000);
      } else if (expires !== undefined) {
        this.scheduleRenewal(this.renewalBackoffMs);
        this.renewalBackoffMs = Math.min(3_600_000, this.renewalBackoffMs * 2);
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return (this.closePromise ??= this.closeInternal());
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.markUnavailable();
    this.closed = true;
    this.lifecycle.abort();
    if (this.renewalTimer) clearTimeout(this.renewalTimer);
    this.renewalTimer = undefined;
    this.renewalDeadline = undefined;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.challenges.clear();
    for (const controller of this.issueAbortControllers.values()) controller.abort();
    await Promise.allSettled([this.startPromise, this.issuePromise]);
    await Promise.allSettled(this.pendingWrites);
    await this.closeChallengeServer();
    await this.storageLock.release();
  }
}

export async function prepareHttpTls(options: HttpTlsOptions, dependencies?: HttpTlsDependencies): Promise<HttpTlsController> {
  return new TlsController(options, dependencies);
}
