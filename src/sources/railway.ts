import type { StatusSource } from "../domain/ports.ts";
import { worst, type Status } from "../domain/status.ts";
import { incident, iso, plain } from "./util.ts";

/** Railway moved off Statuspage to its own page, which serves everything at `/api/status`. */
interface RwEvent {
  id: string;
  slug: string;
  title: string;
  status: string;
  createdAt: string;
  components?: { name: string; groupName?: string; impact?: string }[];
  updates?: { status: string; message: string; createdAt: string }[];
}

const BASE = "https://status.railway.com";
const IMPACT: Record<string, Status> = {
  DEGRADED_PERFORMANCE: "degraded",
  PARTIAL_OUTAGE: "partial_outage",
  MAJOR_OUTAGE: "major_outage",
  UNDER_MAINTENANCE: "maintenance",
};

export const railway: StatusSource = async (_config, http) => {
  const data = await http.json<{ activeIncidents?: RwEvent[]; maintenances?: RwEvent[] }>(`${BASE}/api/status`);
  const maintenances = (data.maintenances ?? []).filter((m) => /progress/i.test(m.status));

  const toIncident = (e: RwEvent, maintenance: boolean) => {
    const components = (e.components ?? []).map((c) => ({
      name: c.groupName ? `${c.groupName} / ${c.name}` : c.name,
      status: maintenance ? ("maintenance" as const) : (IMPACT[c.impact ?? ""] ?? "degraded"),
    }));
    return {
      components,
      incident: incident({
        id: e.id,
        title: e.title,
        status: e.status.toLowerCase(),
        impact: maintenance ? "maintenance" : worst(components.map((c) => c.status), "degraded"),
        url: `${BASE}/incident/${e.slug}`,
        components: components.map((c) => c.name),
        startedAt: iso(e.createdAt),
        updates: (e.updates ?? []).map((u) => ({ at: iso(u.createdAt), status: u.status.toLowerCase(), body: plain(u.message) })),
      }),
    };
  };

  const events = [
    ...(data.activeIncidents ?? []).map((e) => toIncident(e, false)),
    ...maintenances.map((e) => toIncident(e, true)),
  ];
  const incidents = events.map((e) => e.incident);

  return {
    status: worst(incidents.map((i) => i.impact)),
    summary: incidents.length ? incidents.map((i) => i.title).join("; ") : "All systems operational",
    components: events.flatMap((e) => e.components),
    incidents,
  };
};
