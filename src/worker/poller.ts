import { createHash } from "node:crypto";
import type { Http, PollResult, StatusSource, StatusWriter } from "../domain/ports.ts";
import { normalize } from "../domain/snapshot.ts";
import type { Provider, SourceKind } from "../domain/types.ts";

interface Deps {
  writer: StatusWriter;
  http: Http;
  sources: Record<SourceKind, StatusSource>;
  concurrency: number;
  log: (line: string) => void;
}

/**
 * Polls every due provider, then writes one batch. Unchanged feeds (same fingerprint as
 * the last stored snapshot) only bump `checked_at`, so a quiet minute costs one UPDATE.
 */
export function createPoller({ writer, http, sources, concurrency, log }: Deps) {
  const nextRun = new Map<string, number>();
  let fingerprints: Map<string, string> | undefined;

  async function poll(provider: Provider): Promise<PollResult> {
    try {
      const snapshot = normalize(await sources[provider.source](provider.config, http));
      const fingerprint = createHash("sha1").update(JSON.stringify(snapshot)).digest("base64url");
      if (fingerprints!.get(provider.id) === fingerprint) return { providerId: provider.id, ok: true, changed: false };
      return { providerId: provider.id, ok: true, changed: true, snapshot, fingerprint };
    } catch (error) {
      return { providerId: provider.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return async function tick(): Promise<void> {
    fingerprints ??= await writer.fingerprints();
    const now = Date.now();
    const due = (await writer.providers()).filter((p) => (nextRun.get(p.id) ?? 0) <= now);
    if (!due.length) return;
    for (const p of due) nextRun.set(p.id, now + p.intervalSec * 1000);

    const results = await mapLimit(due, concurrency, poll);
    await writer.save(results);
    for (const r of results) if (r.ok && r.changed) fingerprints.set(r.providerId, r.fingerprint);

    const changed = results.filter((r) => r.ok && r.changed).map((r) => r.providerId);
    const failed = results.filter((r) => !r.ok);
    log(
      `polled ${results.length} in ${Date.now() - now} ms` +
        (changed.length ? `, changed: ${changed.join(", ")}` : "") +
        (failed.length ? `, failed: ${failed.map((r) => r.providerId).join(", ")}` : ""),
    );
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
