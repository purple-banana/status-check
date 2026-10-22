import type { StatusSource } from "../domain/ports.ts";
import { worst, type Status } from "../domain/status.ts";
import type { Component } from "../domain/types.ts";
import { incident, iso, join, plain, requireString } from "./util.ts";

/**
 * Atlassian Statuspage `/api/v2/summary.json`. incident.io status pages serve the
 * same format, so this one source covers most vendors.
 */
interface Summary {
  status: { indicator: string; description: string };
  components?: { id: string; name: string; status: string; group?: boolean; group_id?: string | null }[];
  incidents?: SpIncident[];
  scheduled_maintenances?: SpIncident[];
}

interface SpIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink?: string;
  created_at: string;
  started_at?: string;
  updated_at?: string;
  components?: { name: string }[];
  incident_updates?: { status: string; body: string; created_at: string; display_at?: string }[];
}

const INDICATOR: Record<string, Status> = {
  none: "operational",
  minor: "degraded",
  major: "partial_outage",
  critical: "major_outage",
  maintenance: "maintenance",
};

const COMPONENT: Record<string, Status> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial_outage",
  major_outage: "major_outage",
  under_maintenance: "maintenance",
};

const ACTIVE_MAINTENANCE = new Set(["in_progress", "verifying"]);

export const statuspage: StatusSource = async (config, http) => {
  const base = requireString(config, "url");
  const summary = await http.json<Summary>(join(base, "api/v2/summary.json"));
  const all = summary.components ?? [];
  const groups = new Map(all.filter((c) => c.group).map((c) => [c.id, c.name]));

  const components: Component[] = all
    .filter((c) => !c.group && c.status !== "operational")
    .map((c) => ({
      name: c.group_id && groups.has(c.group_id) ? `${groups.get(c.group_id)} / ${c.name}` : c.name,
      status: COMPONENT[c.status] ?? "degraded",
    }));

  const maintenances = (summary.scheduled_maintenances ?? []).filter((m) => ACTIVE_MAINTENANCE.has(m.status));
  const incidents = [
    ...(summary.incidents ?? []).map((i) => toIncident(i, INDICATOR[i.impact] ?? "degraded")),
    ...maintenances.map((m) => toIncident(m, "maintenance")),
  ];

  return {
    status: worst([INDICATOR[summary.status.indicator] ?? "unknown", ...(maintenances.length ? ["maintenance" as const] : [])]),
    summary: summary.status.description,
    components,
    incidents,
  };
};

const toIncident = (i: SpIncident, impact: Status) =>
  incident({
    id: i.id,
    title: i.name,
    status: i.status,
    impact,
    url: i.shortlink,
    components: (i.components ?? []).map((c) => c.name),
    startedAt: iso(i.started_at ?? i.created_at),
    updatedAt: i.updated_at ? iso(i.updated_at) : undefined,
    updates: (i.incident_updates ?? []).map((u) => ({
      at: iso(u.display_at ?? u.created_at),
      status: u.status,
      body: plain(u.body),
    })),
  });
