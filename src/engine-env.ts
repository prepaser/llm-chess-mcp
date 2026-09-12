const REMOVED_ENGINE_ENV = new Set(["HTTP_BEARER", "LICHESS_TOKEN"]);

export function engineChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (REMOVED_ENGINE_ENV.has(key.toUpperCase())) delete env[key];
  }
  return env;
}
