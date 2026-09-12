import { AsyncLocalStorage } from "node:async_hooks";

export type AcmeModule = {
  Client: new (options: {
    directoryUrl: string;
    accountKey: string;
    backoffAttempts?: number;
    backoffMin?: number;
    backoffMax?: number;
  }) => AcmeClient;
  crypto: {
    createPrivateRsaKey(): Promise<Buffer | string>;
    createCsr(options: { altNames: [string] }): Promise<[Buffer | string, Buffer | string]>;
  };
  axios?: {
    interceptors?: {
      request?: {
        use(handler: (config: Record<string, unknown>) => Record<string, unknown>): unknown;
      };
    };
  };
};

export type AcmeClient = {
  auto(options: {
    csr: string | Buffer;
    email: string;
    termsOfServiceAgreed: true;
    challengePriority: ["http-01"];
    challengeCreateFn: (
      authz: { identifier?: { value?: string } },
      challenge: { token?: string },
      keyAuthorization: string,
    ) => Promise<void>;
    challengeRemoveFn: (
      authz: { identifier?: { value?: string } },
      challenge: { token?: string },
      keyAuthorization: string,
    ) => Promise<void>;
  }): Promise<string>;
  waitForValidStatus?: (item: { url?: string }) => Promise<unknown>;
  verifyChallenge?: (authz: { url?: string }, challenge: { url?: string; type?: string }) => Promise<unknown>;
  api?: {
    apiRequest(url: string, payload: null, validStatusCodes: [number]): Promise<{
      data: Record<string, unknown>;
    }>;
  };
};

export const acmeAbortStorage = new AsyncLocalStorage<AbortSignal>();
const axiosInterceptors = new WeakSet<object>();
const patchedPollingClients = new WeakSet<object>();

type AcmeRetryOptions = {
  attempts: number;
  min: number;
  max: number;
};

const DEFAULT_RETRY: AcmeRetryOptions = { attempts: 10, min: 5_000, max: 30_000 };
const SUPPORTED_CHALLENGES = new Set(["http-01", "dns-01", "tls-alpn-01"]);

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException("ACME operation cancelled", "AbortError");
}

function sleepWithAbort(signal: AbortSignal, delayMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortError(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
  });
}

class NonRetryableAcmeError extends Error {}

function formatAcmeResponseError(data: Record<string, unknown>): string {
  const error = data.error;
  const result = error && typeof error === "object"
    ? (error as Record<string, unknown>).detail ?? error
    : error ?? data.detail ?? JSON.stringify(data);
  return String(result ?? "").replace(/\n/g, "");
}

async function retryWithAbort<T>(signal: AbortSignal, operation: () => Promise<T>, retryable: (error: unknown) => boolean, options: AcmeRetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    signal.throwIfAborted();
    try {
      const result = await operation();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw abortError(signal);
      if (!retryable(error) || attempt >= options.attempts) throw error;
      const delay = Math.min(options.min * (2 ** (attempt - 1)), options.max);
      await sleepWithAbort(signal, delay);
    }
  }
}

export function installAcmeAbortPolling(client: AcmeClient, signal: AbortSignal, retry: AcmeRetryOptions = DEFAULT_RETRY): void {
  if (patchedPollingClients.has(client)) return;
  const api = client.api;
  const originalVerifyChallenge = client.verifyChallenge;
  if (typeof client.waitForValidStatus === "function" && typeof api?.apiRequest !== "function") {
    throw new Error("unsupported ACME client: status polling API is unavailable");
  }
  if (api && typeof client.waitForValidStatus === "function") {
    client.waitForValidStatus = async (item): Promise<unknown> => {
      if (!item.url) throw new Error("Unable to verify status of item, URL not found");
      return retryWithAbort(signal, async () => {
        const response = await api.apiRequest(item.url!, null, [200]);
        const status = response.data.status;
        if (status === "ready" || status === "valid") return response.data;
        if (status === "invalid") throw new NonRetryableAcmeError(formatAcmeResponseError(response.data));
        throw new Error(`ACME item is not ready (status: ${String(status ?? "unknown")})`);
      }, (error) => !(error instanceof NonRetryableAcmeError), retry);
    };
  }
  if (typeof originalVerifyChallenge === "function") {
    client.verifyChallenge = (authz, challenge): Promise<unknown> => {
      if (!authz.url || !challenge.url || !SUPPORTED_CHALLENGES.has(challenge.type ?? "")) {
        return originalVerifyChallenge.call(client, authz, challenge);
      }
      return retryWithAbort(
        signal,
        () => originalVerifyChallenge.call(client, authz, challenge),
        () => true,
        retry,
      );
    };
  }
  patchedPollingClients.add(client);
}

export function installAcmeAbortInterceptor(acme: AcmeModule): void {
  const axios = acme.axios;
  if (!axios || (typeof axios !== "object" && typeof axios !== "function") || axiosInterceptors.has(axios)) return;
  const requestInterceptor = axios.interceptors?.request;
  const use = requestInterceptor?.use;
  if (typeof use !== "function") return;
  use.call(requestInterceptor, (config) => {
    const signal = acmeAbortStorage.getStore();
    if (signal) {
      config.signal = signal;
      config.retryAttempt = Number.MAX_SAFE_INTEGER;
    }
    return config;
  });
  axiosInterceptors.add(axios);
}

export async function loadAcme(): Promise<unknown> {
  return import("acme-client");
}

export function unwrapAcmeModule(module: unknown): AcmeModule {
  if (!module || typeof module !== "object") throw new Error("invalid acme-client module");
  const record = module as Record<string, unknown>;
  const value = record.default && typeof record.default === "object" ? record.default : record;
  if (!("Client" in value) || !("crypto" in value)) throw new Error("invalid acme-client module");
  return value as unknown as AcmeModule;
}
