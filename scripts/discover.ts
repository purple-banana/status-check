/**
 * Detects how a status page publishes its data and prints a catalog entry for it.
 *
 *   npm run discover -- https://status.example.com
 */
import type { Http } from "../src/domain/ports.ts";
import type { SourceKind } from "../src/domain/types.ts";
import { createHttp } from "../src/infra/http.ts";
import { sources } from "../src/sources/index.ts";

export interface Detected {
  source: SourceKind;
  config: Record<string, unknown>;
}

export async function detect(url: string, http: Http): Promise<Detected | null> {
  // Status pages move (platform.sh -> upsun.com); feeds live under the final address.
  const final = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(10_000) })
    .then((res) => res.url)
    .catch(() => url);
  const base = new URL(final).origin;
  const candidates: Detected[] = [
    { source: "statuspage", config: { url: base } },
    { source: "instatus", config: { url: base } },
    { source: "betterstack", config: { url: base } },
  ];

  const html = await http.text(base).catch(() => "");
  const statusio = /statuspage_id\s*[:=]\s*['"]([a-f0-9]{24})/.exec(html)?.[1];
  if (statusio) candidates.unshift({ source: "statusio", config: { pageId: statusio } });
  const incidentio = /https:\/\/statuspage\.incident\.io\/([\w-]+)/.exec(html)?.[1];
  if (incidentio) candidates.push({ source: "statuspage", config: { url: `https://statuspage.incident.io/${incidentio}` } });
  const feed = /<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*href="([^"]+)"/.exec(html)?.[1];
  if (feed) candidates.push({ source: "feed", config: { url: new URL(feed, `${base}/`).href } });

  for (const candidate of candidates) {
    const ok = await sources[candidate.source](candidate.config, http).then(
      (snapshot) => snapshot.status !== "unknown",
      () => false,
    );
    if (ok) return candidate;
  }
  return null;
}

if (import.meta.main) {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run discover -- <status page url>");
    process.exit(1);
  }
  const http = createHttp({ timeoutMs: 10_000, userAgent: "status-check-discover" });
  const found = await detect(url, http);
  if (!found) {
    console.error(`No supported feed found at ${url}. Consider a "probe" entry instead.`);
    process.exit(1);
  }
  const snapshot = await sources[found.source](found.config, http);
  console.log(JSON.stringify({ ...found, status: snapshot.status, summary: snapshot.summary }, null, 2));
  console.log(`\nsource: "${found.source}", config: ${JSON.stringify(found.config)}`);
}
