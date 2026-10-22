import type { Http, StatusSource } from "../domain/ports.ts";
import type { Snapshot } from "../domain/types.ts";
import { requireString } from "./util.ts";

/**
 * Synthetic check for services without a public status feed: request a URL and judge the
 * answer. Any response below 500 means the service is up (401/404 still prove the edge and
 * app respond). One retry filters out single dropped requests.
 */
export const probe: StatusSource = async (config, http) => {
  const url = requireString(config, "url");
  const method = typeof config.method === "string" ? config.method : "GET";
  const degradedMs = Number(config.degradedMs ?? 4000);

  const first = await attempt(http, url, method);
  const result = first.ok ? first : await attempt(http, url, method);

  const status = !result.ok ? "major_outage" : result.ms > degradedMs ? "degraded" : "operational";
  // No latency in the text: it would change every poll and force a database write.
  const summary = !result.ok
    ? `Synthetic check failed: ${result.detail}`
    : status === "degraded"
      ? `Synthetic check: responding slowly (over ${degradedMs} ms)`
      : "Synthetic check: responding";

  return { status, summary, components: [], incidents: [] } satisfies Snapshot;
};

async function attempt(http: Http, url: string, method: string) {
  try {
    const { status, ms } = await http.probe(url, method);
    return { ok: status < 500, ms, detail: String(status) };
  } catch (error) {
    return { ok: false, ms: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}
