import type { ProviderStatus, StatusReader, StoredIncident } from "../domain/ports.ts";

interface Snapshot {
  statuses: ProviderStatus[];
  active: StoredIncident[];
  health: Awaited<ReturnType<StatusReader["health"]>>;
}

/**
 * Serves the current state from memory. Every status and active incident is reloaded at
 * most once per `ttlMs`, and concurrent callers share that one load, so a burst of agent
 * calls costs one round of queries per window. A failed reload keeps serving the last good
 * snapshot. History and free-text search still go to the database.
 */
export function cachedReader(reader: StatusReader, ttlMs: number, now = Date.now): StatusReader {
  let snapshot: Promise<Snapshot> | undefined;
  let loadedAt = 0;

  function current(): Promise<Snapshot> {
    if (snapshot && now() - loadedAt < ttlMs) return snapshot;
    loadedAt = now();
    const previous = snapshot;
    snapshot = Promise.all([reader.statuses(), reader.incidents({ active: true }), reader.health()])
      .then(([statuses, active, health]) => ({ statuses, active, health }))
      .catch((error) => {
        // Keep the last good state for another window rather than retrying on every call.
        if (previous) return previous;
        loadedAt = 0;
        snapshot = undefined;
        throw error;
      });
    return snapshot;
  }

  return {
    resolve: (names) => reader.resolve(names),
    changes: (providerId, sinceDays) => reader.changes(providerId, sinceDays),

    async statuses(ids) {
      const { statuses } = await current();
      return ids ? statuses.filter((p) => ids.includes(p.id)) : statuses;
    },

    async incidents(filter) {
      if (!filter.active || filter.sinceDays) return reader.incidents(filter);
      const { active } = await current();
      return filter.providerIds ? active.filter((i) => filter.providerIds!.includes(i.providerId)) : active;
    },

    async search(query, category) {
      // Name search also matches aliases, which the snapshot does not hold.
      if (query) return reader.search(query, category);
      const { statuses } = await current();
      return category ? statuses.filter((p) => p.category === category) : statuses;
    },

    async health() {
      return (await current()).health;
    },
  };
}
