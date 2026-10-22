import type { Http } from "../domain/ports.ts";

interface Cached {
  etag: string | null;
  lastModified: string | null;
  body: string;
  parsed?: unknown;
}

/**
 * fetch with a timeout and conditional requests: when a vendor answers 304 we reuse
 * the last body (and its parsed JSON) instead of downloading and parsing it again.
 */
export function createHttp({ timeoutMs, userAgent }: { timeoutMs: number; userAgent: string }): Http {
  const cache = new Map<string, Cached>();

  async function get(url: string, accept: string): Promise<Cached> {
    const cached = cache.get(url);
    const headers: Record<string, string> = { accept, "user-agent": userAgent };
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified) headers["if-modified-since"] = cached.lastModified;

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (res.status === 304 && cached) return cached;
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);

    const entry: Cached = {
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      body: decode(await res.arrayBuffer(), res.headers.get("content-type")),
    };
    if (entry.etag || entry.lastModified) cache.set(url, entry);
    else cache.delete(url);
    return entry;
  }

  return {
    async json<T>(url: string): Promise<T> {
      const entry = await get(url, "application/json");
      entry.parsed ??= JSON.parse(entry.body);
      return entry.parsed as T;
    },
    async text(url: string): Promise<string> {
      return (await get(url, "*/*")).body;
    },
    async probe(url: string, method = "GET") {
      const started = performance.now();
      const res = await fetch(url, {
        method,
        headers: { "user-agent": userAgent },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
      await res.body?.cancel();
      return { status: res.status, ms: Math.round(performance.now() - started) };
    },
  };
}

/** Some feeds (AWS) are UTF-16; the byte-order mark tells which endianness. */
function decode(buffer: ArrayBuffer, contentType: string | null): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || /charset=utf-16/i.test(contentType ?? "");
  return new TextDecoder(utf16 ? "utf-16le" : "utf-8").decode(bytes);
}
