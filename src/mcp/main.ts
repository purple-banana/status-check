import { catalog } from "../catalog/providers.ts";
import { config } from "../config.ts";
import { cachedReader } from "../store/cached.ts";
import { connect, createReader } from "../store/postgres.ts";
import { createServer } from "./server.ts";

// mcp-use reports anonymous usage to its authors unless told not to; opt in by setting it to "true".
process.env.MCP_USE_ANONYMIZED_TELEMETRY ??= "false";

const sql = connect(config.databaseUrl(), 10);
const server = createServer(cachedReader(createReader(sql), config.cacheMs), {
  host: config.host,
  port: config.port,
  allowedHosts: config.allowedHosts,
  categories: [...new Set(catalog.map((p) => p.category))].sort(),
});

const { url } = await server.listen();
console.log(`status-check MCP listening on ${url}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await server.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
