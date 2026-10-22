/**
 * Polls every catalog provider once and lists the ones whose feed fails. Run it before
 * sending a catalog change, or on a schedule to catch vendors that moved their status page.
 *
 *   npm run verify            # all providers
 *   npm run verify -- neon    # only these ids
 */
import { catalog } from "../src/catalog/providers.ts";
import { createHttp } from "../src/infra/http.ts";
import { sources } from "../src/sources/index.ts";

const only = new Set(process.argv.slice(2));
const providers = only.size ? catalog.filter((p) => only.has(p.id)) : catalog;
const http = createHttp({ timeoutMs: 15_000, userAgent: "status-check-verify" });

const failures: string[] = [];
await Promise.all(
  providers.map(async (p) => {
    try {
      const s = await sources[p.source](p.config, http);
      if (s.status !== "operational") console.log(`${p.id}: ${s.status} (${s.incidents.length} incidents)`);
    } catch (error) {
      failures.push(`${p.id} [${p.source}]: ${error instanceof Error ? error.message : error}`);
    }
  }),
);

console.log(`\n${providers.length - failures.length}/${providers.length} feeds OK`);
if (failures.length) {
  console.log(failures.sort().join("\n"));
  process.exitCode = 1;
}
