import { MCPServer, type CallToolResult } from "mcp-use";
import { z } from "zod";
import type { ProviderStatus, StatusReader, StoredIncident } from "../domain/ports.ts";
import { severity, type Status } from "../domain/status.ts";
import { detail, headline, history, incidentLine } from "./format.ts";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const text = (body: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: body }], isError });

const byProvider = (incidents: StoredIncident[]) => Map.groupBy(incidents, (i) => i.providerId);

/** Headline plus at most three incidents, so one noisy vendor cannot flood the answer. */
function summarize(p: ProviderStatus, incidents: StoredIncident[] = []): string[] {
  const more = incidents.length - 3;
  return [headline(p), ...incidents.slice(0, 3).map((i) => incidentLine(i)), ...(more > 0 ? [`  +${more} more (get_status ${p.id})`] : [])];
}

interface Options {
  host: string;
  port: number;
  allowedHosts: string[];
  categories: string[];
}

export function createServer(reader: StatusReader, { host, port, allowedHosts, categories }: Options): MCPServer {
  const server = new MCPServer({
    name: "status-check",
    title: "Status Check",
    version: "0.1.0",
    description: "Live status and incidents of cloud, SaaS and AI providers, refreshed every minute from their official status pages.",
    instructions:
      "When a deploy, build, API call, login or network request fails in a way your change does not explain, call check_stack " +
      "with the services involved before debugging further: an upstream outage explains errors no code change will fix. " +
      "Use list_incidents for 'is anything down right now', get_status for the full timeline of one provider.",
    host,
    port,
    allowedHosts: allowedHosts.length ? allowedHosts : undefined,
  });

  // Matched case-insensitively. An unknown category is an error, never an empty all-clear.
  const known = new Set(categories);
  const unknownCategory = (category?: string) =>
    category !== undefined && !known.has(category.toLowerCase())
      ? text(`Unknown category "${category}". Categories: ${categories.join(", ")}.`, true)
      : null;

  const resolveOne = async (name: string) => (await reader.resolve([name])).get(name) ?? null;
  const notFound = (name: string) => text(`No tracked provider matches "${name}". Use search_providers to find its id.`, true);

  server.tool(
    {
      name: "check_stack",
      title: "Check stack",
      description:
        "Status of the services a task depends on, in one call. Pass names or ids (e.g. ['github', 'vercel', 'supabase', 'aws']). " +
        "Returns each provider's status, how long it has been in it, and the latest update of every active incident.",
      inputSchema: z.object({
        providers: z.array(z.string().min(1)).min(1).max(40).describe("Provider names or ids, e.g. 'Railway', 'gh', 'claude'"),
      }),
      annotations: READ_ONLY,
    },
    async ({ providers }) => {
      const resolved = await reader.resolve(providers);
      const ids = [...new Set([...resolved.values()].filter((id): id is string => id !== null))];
      const [statuses, incidents] = await Promise.all([
        reader.statuses(ids),
        reader.incidents({ providerIds: ids, active: true }),
      ]);
      const active = byProvider(incidents);

      const lines = statuses.flatMap((p) => summarize(p, active.get(p.id)));
      const missing = [...resolved].filter(([, id]) => id === null).map(([name]) => name);
      if (missing.length) lines.push(`Not tracked: ${missing.join(", ")} (try search_providers).`);
      const down = statuses.filter((p) => severity(p.status) >= severity("degraded")).length;
      lines.unshift(down ? `${down} of ${statuses.length} have problems:` : `All ${statuses.length} operational.`);
      return text(lines.join("\n"));
    },
  );

  server.tool(
    {
      name: "list_incidents",
      title: "List incidents",
      description: "Every tracked provider that is degraded or down right now, with its active incidents. Answers 'is anything down?'.",
      inputSchema: z.object({
        category: z.string().optional().describe(`Limit to one category: ${categories.join(", ")}`),
        minimum: z
          .enum(["degraded", "partial_outage", "major_outage"])
          .default("degraded")
          .describe("Lowest severity to include"),
      }),
      annotations: READ_ONLY,
    },
    async ({ category, minimum }) => {
      const invalid = unknownCategory(category);
      if (invalid) return invalid;
      const all = await reader.search(undefined, category?.toLowerCase());
      const affected = all.filter((p) => severity(p.status) >= severity(minimum as Status));
      if (!affected.length) return text(`No problems at or above ${minimum} across ${all.length} tracked providers.`);

      const active = byProvider(await reader.incidents({ providerIds: affected.map((p) => p.id), active: true }));
      const lines = affected.flatMap((p) => summarize(p, active.get(p.id)));
      return text([`${affected.length} of ${all.length} providers have problems:`, ...lines].join("\n"));
    },
  );

  server.tool(
    {
      name: "get_status",
      title: "Get provider status",
      description: "Full current status of one provider: affected components and each active incident with its latest updates (the why).",
      inputSchema: z.object({ provider: z.string().min(1).describe("Provider name or id") }),
      annotations: READ_ONLY,
    },
    async ({ provider }) => {
      const id = await resolveOne(provider);
      if (!id) return notFound(provider);
      const [[status], incidents] = await Promise.all([reader.statuses([id]), reader.incidents({ providerIds: [id], active: true })]);
      return text(detail(status!, incidents));
    },
  );

  server.tool(
    {
      name: "get_history",
      title: "Get provider history",
      description: "Status changes and incidents (active and resolved) of one provider over the last N days.",
      inputSchema: z.object({
        provider: z.string().min(1).describe("Provider name or id"),
        days: z.number().int().min(1).max(90).default(7),
      }),
      annotations: READ_ONLY,
    },
    async ({ provider, days }) => {
      const id = await resolveOne(provider);
      if (!id) return notFound(provider);
      const [[status], changes, incidents] = await Promise.all([
        reader.statuses([id]),
        reader.changes(id, days),
        reader.incidents({ providerIds: [id], sinceDays: days }),
      ]);
      return text(history(status!, changes, incidents, days));
    },
  );

  server.tool(
    {
      name: "search_providers",
      title: "Search providers",
      description: "Find tracked providers and their ids by name or category. Without arguments, lists categories.",
      inputSchema: z.object({
        query: z.string().optional().describe("Part of a name or id, e.g. 'mail'"),
        category: z.string().optional().describe(`One of: ${categories.join(", ")}`),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, category }) => {
      if (!query && !category) {
        const all = await reader.search();
        const counts = Map.groupBy(all, (p) => p.category);
        return text(
          [`${all.length} providers. Categories:`, ...[...counts].sort().map(([c, ps]) => `  ${c} (${ps.length})`)].join("\n"),
        );
      }
      const invalid = unknownCategory(category);
      if (invalid) return invalid;
      const found = await reader.search(query, category?.toLowerCase());
      if (!found.length) return text(`No provider matches${query ? ` "${query}"` : ""}${category ? ` in ${category}` : ""}.`);
      return text(found.map((p) => `${p.id} — ${p.name} [${p.category}]: ${p.status}`).join("\n"));
    },
  );

  server.get("/health", async (c) => {
    const { lastCheckedAt, providers } = await reader.health();
    const fresh = lastCheckedAt !== null && Date.now() - Date.parse(lastCheckedAt) < 5 * 60_000;
    return c.json({ ok: fresh, providers, lastCheckedAt }, fresh ? 200 : 503);
  });

  // Plain JSON for web pages (the isup.fyi live panel): every provider with a problem and
  // the latest update of its active incidents. Short cache so a busy page is one query a minute.
  server.get("/api/incidents", async (c) => {
    const [all, { lastCheckedAt }] = await Promise.all([reader.search(), reader.health()]);
    const affected = all.filter((p) => severity(p.status) >= severity("degraded"));
    const active = affected.length ? byProvider(await reader.incidents({ providerIds: affected.map((p) => p.id), active: true })) : new Map();
    const clip = (body: string) => (body.length > 400 ? `${body.slice(0, 399)}…` : body);

    c.header("cache-control", "public, max-age=30, s-maxage=30");
    return c.json({
      checkedAt: lastCheckedAt,
      providers: all.length,
      affected: affected.map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        status: p.status,
        summary: p.summary,
        since: p.changedAt,
        url: p.url,
        incidents: (active.get(p.id) ?? []).slice(0, 3).map((i: StoredIncident) => ({
          title: i.title,
          impact: i.impact,
          status: i.status,
          url: i.url ?? null,
          startedAt: i.startedAt,
          update: i.updates[0] ? { ...i.updates[0], body: clip(i.updates[0].body) } : null,
        })),
      })),
    });
  });

  return server;
}
