import type { Status } from "./status.ts";
import type { Component, Incident, Provider, Snapshot } from "./types.ts";

/** HTTP access for sources. Implementations handle timeouts and conditional requests. */
export interface Http {
  json<T>(url: string): Promise<T>;
  text(url: string): Promise<string>;
  /** Raw request for synthetic checks. Never throws on HTTP errors, only on network failure. */
  probe(url: string, method?: string): Promise<{ status: number; ms: number }>;
}

/** Reads one provider's status from wherever the vendor publishes it. */
export type StatusSource = (config: Record<string, unknown>, http: Http) => Promise<Snapshot>;

/** `changed: false` means the feed says the same as last time: only the check time moves. */
export type PollResult =
  | { providerId: string; ok: true; changed: false }
  | { providerId: string; ok: true; changed: true; snapshot: Snapshot; fingerprint: string }
  | { providerId: string; ok: false; error: string };

/** Write side, used by the worker. */
export interface StatusWriter {
  syncCatalog(providers: Provider[]): Promise<void>;
  providers(): Promise<Provider[]>;
  fingerprints(): Promise<Map<string, string>>;
  save(results: PollResult[]): Promise<void>;
}

export interface ProviderStatus {
  id: string;
  name: string;
  category: string;
  url: string;
  source: string;
  status: Status;
  summary: string;
  components: Component[];
  checkedAt: string | null;
  changedAt: string | null;
  error: string | null;
  errorAt: string | null;
}

export interface StoredIncident extends Incident {
  providerId: string;
  resolvedAt: string | null;
}

export interface StatusChange {
  at: string;
  status: Status;
}

/** Read side, used by the MCP server. */
export interface StatusReader {
  /** Maps free-form names ("GitHub", "gh", "vercel") to provider ids. */
  resolve(names: string[]): Promise<Map<string, string | null>>;
  statuses(ids?: string[]): Promise<ProviderStatus[]>;
  incidents(filter: { providerIds?: string[]; active?: boolean; sinceDays?: number }): Promise<StoredIncident[]>;
  changes(providerId: string, sinceDays: number): Promise<StatusChange[]>;
  search(query?: string, category?: string): Promise<ProviderStatus[]>;
  /** When the worker last checked any provider: tells whether the data is live. */
  health(): Promise<{ lastCheckedAt: string | null; providers: number }>;
}
