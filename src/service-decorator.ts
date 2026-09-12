import type { AppServices } from "./services.js";

const SERVICE_METHODS = [
  "analyzeEngines",
  "analyze",
  "humanMoveDistribution",
  "explorerEnabled",
  "openingExplorer",
  "computeCandidates",
  "computeEngineCandidates",
  "rankEngineCandidates",
  "rankByIntent",
  "quit",
] as const satisfies readonly (keyof AppServices)[];

type ServiceMethodKey = (typeof SERVICE_METHODS)[number];

export type AppServicesOverrides = { [K in ServiceMethodKey]?: AppServices[K] | undefined } &
  Partial<Pick<AppServices, "games">>;

export function decorateAppServices(
  services: AppServices,
  overrides: AppServicesOverrides = {},
): AppServices {
  const decorated: Partial<AppServices> = {
    get games() { return overrides.games ?? services.games; },
  };

  for (const key of SERVICE_METHODS) {
    Object.defineProperty(decorated, key, {
      enumerable: true,
      get: () => {
        const method = (Object.hasOwn(overrides, key) ? overrides[key] : services[key]) as unknown as
          ((...args: never[]) => unknown) | undefined;
        return typeof method === "function"
          ? (...args: never[]) => method.apply(services, args)
          : undefined;
      },
    });
  }

  return decorated as AppServices;
}
