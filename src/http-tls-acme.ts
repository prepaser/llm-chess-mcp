import { AsyncLocalStorage } from "node:async_hooks";

export type AcmeModule = {
  Client: new (options: { directoryUrl: string; accountKey: string }) => {
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
  };
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

export const acmeAbortStorage = new AsyncLocalStorage<AbortSignal>();
const axiosInterceptors = new WeakSet<object>();

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
