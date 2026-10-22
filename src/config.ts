const env = process.env;

function required(name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const list = (value: string | undefined) => value?.split(",").map((v) => v.trim()).filter(Boolean) ?? [];

export const config = {
  databaseUrl: () => required("DATABASE_URL"),
  /** Worker */
  concurrency: Number(env.POLL_CONCURRENCY ?? 16),
  timeoutMs: Number(env.REQUEST_TIMEOUT_MS ?? 10_000),
  tickMs: Number(env.TICK_MS ?? 15_000),
  userAgent: env.USER_AGENT ?? "status-check/0.1",
  /** MCP server */
  host: env.HOST ?? "0.0.0.0",
  port: Number(env.PORT ?? 3000),
  allowedHosts: list(env.ALLOWED_HOSTS),
  /** How long the MCP server answers current-state questions from memory before reloading. */
  cacheMs: Number(env.CACHE_TTL_MS ?? 15_000),
};
