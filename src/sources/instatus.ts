import type { StatusSource } from "../domain/ports.ts";
import { worst, type Status } from "../domain/status.ts";
import { incident, iso, join, requireString } from "./util.ts";

/** Instatus `summary.json`, plus `v2/components.json` only when something is wrong. */
interface Summary {
  page: { status: string };
  activeIncidents?: InEvent[];
  activeMaintenances?: InEvent[];
}

interface InEvent {
  id: string;
  name: string;
  started?: string;
  status: string;
  impact?: string;
  url?: string;
  updatedAt?: string;
}

const LEVEL: Record<string, Status> = {
  UP: "operational",
  OPERATIONAL: "operational",
  HASISSUES: "degraded",
  DEGRADEDPERFORMANCE: "degraded",
  PARTIALOUTAGE: "partial_outage",
  MAJOROUTAGE: "major_outage",
  UNDERMAINTENANCE: "maintenance",
};

const level = (value: string | undefined) => LEVEL[value?.toUpperCase() ?? ""] ?? "degraded";

export const instatus: StatusSource = async (config, http) => {
  const base = requireString(config, "url");
  const summary = await http.json<Summary>(join(base, "summary.json"));
  const page = level(summary.page.status);

  const components =
    page === "operational"
      ? []
      : ((await http.json<{ components: { name: string; status: string }[] }>(join(base, "v2/components.json")))
          .components.filter((c) => c.status !== "OPERATIONAL")
          .map((c) => ({ name: c.name, status: level(c.status) })));

  const toIncident = (e: InEvent, maintenance: boolean) =>
    incident({
      id: e.id,
      title: e.name,
      status: e.status.toLowerCase(),
      impact: maintenance ? "maintenance" : level(e.impact),
      url: e.url,
      startedAt: iso(e.started),
      updatedAt: e.updatedAt ? iso(e.updatedAt) : undefined,
    });

  const incidents = [
    ...(summary.activeIncidents ?? []).map((e) => toIncident(e, false)),
    ...(summary.activeMaintenances ?? []).map((e) => toIncident(e, true)),
  ];

  return {
    status: page === "degraded" ? worst([page, ...incidents.map((i) => i.impact)]) : page,
    summary: page === "operational" ? "All systems operational" : `${incidents.length} active event(s)`,
    components,
    incidents,
  };
};
