import { setTimeout as sleep } from "node:timers/promises";
import { catalog } from "../catalog/providers.ts";
import { config } from "../config.ts";
import { createHttp } from "../infra/http.ts";
import { sources } from "../sources/index.ts";
import { connect, createWriter, migrate } from "../store/postgres.ts";
import { createPoller } from "./poller.ts";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

const sql = connect(config.databaseUrl());
await migrate(sql);
const writer = createWriter(sql);
await writer.syncCatalog(catalog);
log(`synced ${catalog.length} providers`);

const tick = createPoller({
  writer,
  http: createHttp({ timeoutMs: config.timeoutMs, userAgent: config.userAgent }),
  sources,
  concurrency: config.concurrency,
  log,
});

const stop = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal}, stopping`);
    stop.abort();
  });
}

while (!stop.signal.aborted) {
  const started = Date.now();
  await tick().catch((error) => log(`tick failed: ${error instanceof Error ? error.message : error}`));
  await sleep(Math.max(0, config.tickMs - (Date.now() - started)), undefined, { signal: stop.signal }).catch(() => {});
}
await sql.end({ timeout: 5 });
