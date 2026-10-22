import { readFile } from "node:fs/promises";
import postgres from "postgres";
import type { PollResult, ProviderStatus, StatusChange, StatusReader, StatusWriter, StoredIncident } from "../domain/ports.ts";
import { statusSince } from "../domain/snapshot.ts";
import type { Provider, Snapshot } from "../domain/types.ts";

type Sql = postgres.Sql;

const iso = (value: Date | null) => value?.toISOString() ?? null;

/** Most severe first, then unknown, then healthy. */
const SEVERITY_ORDER = "array_position(array['major_outage','partial_outage','degraded','maintenance','unknown','operational'], coalesce(s.status, 'unknown'))";

export function connect(url: string, max = 5): Sql {
  return postgres(url, { max, idle_timeout: 30, onnotice: () => {} });
}

export async function migrate(sql: Sql): Promise<void> {
  await sql.unsafe(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
}

export function createWriter(sql: Sql): StatusWriter {
  return {
    async syncCatalog(providers) {
      const rows = providers.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        url: p.url,
        source: p.source,
        config: sql.json(p.config as postgres.JSONValue),
        aliases: p.aliases,
        interval_sec: p.intervalSec,
      }));
      await sql.begin(async (tx) => {
        await tx`
          insert into providers ${tx(rows)}
          on conflict (id) do update set
            name = excluded.name, category = excluded.category, url = excluded.url, source = excluded.source,
            config = excluded.config, aliases = excluded.aliases, interval_sec = excluded.interval_sec
          where providers.owner is null`;
        await tx`delete from providers where owner is null and id <> all(${rows.map((r) => r.id)}::text[])`;
      });
    },

    async providers() {
      return sql<Provider[]>`
        select id, name, category, url, source, config, aliases, interval_sec as "intervalSec"
        from providers where enabled`;
    },

    async fingerprints() {
      const rows = await sql<{ id: string; fingerprint: string }[]>`select provider_id as id, fingerprint from provider_status`;
      return new Map(rows.map((r) => [r.id, r.fingerprint]));
    },

    async save(results) {
      const unchanged = results.filter((r) => r.ok && !r.changed).map((r) => r.providerId);
      const changed = results.filter((r): r is Extract<PollResult, { changed: true }> => r.ok && r.changed);
      const failed = results.filter((r): r is Extract<PollResult, { ok: false }> => !r.ok);

      await sql.begin(async (tx) => {
        if (unchanged.length) {
          await tx`update provider_status set checked_at = now(), error = null where provider_id = any(${unchanged}::text[])`;
        }
        for (const r of changed) await saveSnapshot(tx, r.providerId, r.snapshot, r.fingerprint);
        if (failed.length) {
          const rows = failed.map((r) => ({ provider_id: r.providerId, status: "unknown", error: r.error.slice(0, 500) }));
          await tx`
            insert into provider_status ${tx(rows)}
            on conflict (provider_id) do update set error = excluded.error, error_at = now()`;
        }
      });
    },
  };
}

async function saveSnapshot(tx: postgres.TransactionSql, providerId: string, snapshot: Snapshot, fingerprint: string) {
  const since = statusSince(snapshot);
  await tx`
    insert into status_changes (provider_id, at, status)
    select ${providerId}, ${since}, ${snapshot.status}
    where not exists (select 1 from provider_status where provider_id = ${providerId} and status = ${snapshot.status})
    on conflict do nothing`;

  await tx`
    insert into provider_status (provider_id, status, summary, components, fingerprint, checked_at, changed_at)
    values (${providerId}, ${snapshot.status}, ${snapshot.summary}, ${tx.json(snapshot.components as never)}, ${fingerprint}, now(), ${since})
    on conflict (provider_id) do update set
      status = excluded.status, summary = excluded.summary, components = excluded.components,
      fingerprint = excluded.fingerprint, checked_at = now(), error = null,
      changed_at = case when provider_status.status = excluded.status then provider_status.changed_at else excluded.changed_at end`;

  if (snapshot.incidents.length) {
    const rows = snapshot.incidents.map((i) => ({
      provider_id: providerId,
      id: i.id,
      title: i.title,
      status: i.status,
      impact: i.impact,
      url: i.url ?? null,
      components: i.components,
      updates: tx.json(i.updates as never),
      started_at: i.startedAt,
      updated_at: i.updatedAt,
    }));
    await tx`
      insert into incidents ${tx(rows)}
      on conflict (provider_id, id) do update set
        title = excluded.title, status = excluded.status, impact = excluded.impact, url = excluded.url,
        components = excluded.components, updates = excluded.updates, updated_at = excluded.updated_at, resolved_at = null`;
  }

  // Sources report active incidents only, so anything that dropped out is over.
  await tx`
    update incidents set resolved_at = now(), status = 'resolved'
    where provider_id = ${providerId} and resolved_at is null and id <> all(${snapshot.incidents.map((i) => i.id)}::text[])`;
}

interface StatusRow extends Omit<ProviderStatus, "checkedAt" | "changedAt" | "errorAt"> {
  checkedAt: Date | null;
  changedAt: Date | null;
  errorAt: Date | null;
}

export function createReader(sql: Sql): StatusReader {
  let names: { at: number; rows: { id: string; keys: string[] }[] } | undefined;

  async function nameIndex() {
    if (!names || Date.now() - names.at > 60_000) {
      const rows = await sql<{ id: string; name: string; aliases: string[] }[]>`select id, name, aliases from providers where enabled`;
      names = { at: Date.now(), rows: rows.map((r) => ({ id: r.id, keys: [r.id, r.name, ...r.aliases].map(key) })) };
    }
    return names.rows;
  }

  async function select(where: postgres.PendingQuery<postgres.Row[]>) {
    const rows = await sql<StatusRow[]>`
      select p.id, p.name, p.category, p.url, p.source,
        coalesce(s.status, 'unknown') as status, coalesce(s.summary, '') as summary,
        coalesce(s.components, '[]') as components,
        s.checked_at as "checkedAt", s.changed_at as "changedAt", s.error, s.error_at as "errorAt"
      from providers p left join provider_status s on s.provider_id = p.id
      where p.enabled ${where}
      order by ${sql.unsafe(SEVERITY_ORDER)}, p.name`;
    return rows.map((r) => ({ ...r, checkedAt: iso(r.checkedAt), changedAt: iso(r.changedAt), errorAt: iso(r.errorAt) }));
  }

  return {
    async resolve(inputs) {
      const index = await nameIndex();
      const result = new Map<string, string | null>();
      for (const input of inputs) {
        const k = key(input);
        const match =
          index.find((p) => p.keys.includes(k)) ??
          (k.length >= 3 ? index.find((p) => p.keys.some((x) => x.startsWith(k) || (x.length > 3 && k.startsWith(x)))) : undefined);
        result.set(input, match?.id ?? null);
      }
      return result;
    },

    statuses(ids) {
      return select(ids ? sql`and p.id = any(${ids}::text[])` : sql``);
    },

    search(query, category) {
      const like = query ? `%${query}%` : null;
      return select(sql`
        ${like ? sql`and (p.id ilike ${like} or p.name ilike ${like} or ${query!.toLowerCase()} = any(p.aliases))` : sql``}
        ${category ? sql`and p.category = ${category}` : sql``}`);
    },

    async incidents({ providerIds, active, sinceDays }) {
      const rows = await sql<(Omit<StoredIncident, "startedAt" | "updatedAt" | "resolvedAt"> & Record<"startedAt" | "updatedAt" | "resolvedAt", Date | null>)[]>`
        select provider_id as "providerId", id, title, status, impact, url, components, updates,
          started_at as "startedAt", updated_at as "updatedAt", resolved_at as "resolvedAt"
        from incidents
        where true
          ${providerIds ? sql`and provider_id = any(${providerIds}::text[])` : sql``}
          ${active ? sql`and resolved_at is null` : sql``}
          ${sinceDays ? sql`and (resolved_at is null or resolved_at > now() - make_interval(days => ${sinceDays}))` : sql``}
        order by started_at desc
        limit 200`;
      return rows.map((r) => ({
        ...r,
        url: r.url ?? undefined,
        startedAt: iso(r.startedAt)!,
        updatedAt: iso(r.updatedAt)!,
        resolvedAt: iso(r.resolvedAt),
      }));
    },

    async health() {
      const [row] = await sql<{ lastCheckedAt: Date | null; providers: number }[]>`
        select max(checked_at) as "lastCheckedAt", count(*)::int as providers from provider_status`;
      return { lastCheckedAt: iso(row?.lastCheckedAt ?? null), providers: row?.providers ?? 0 };
    },

    async changes(providerId, sinceDays) {
      const rows = await sql<{ at: Date; status: StatusChange["status"] }[]>`
        select at, status from status_changes
        where provider_id = ${providerId} and at > now() - make_interval(days => ${sinceDays})
        order by at desc limit 100`;
      return rows.map((r) => ({ at: r.at.toISOString(), status: r.status }));
    },
  };
}

/** "Fly.io", "fly-io" and "flyio" all match. */
const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
