import type { StatusSource } from "../domain/ports.ts";
import { worst, type Status } from "../domain/status.ts";
import { incident, iso, plain } from "./util.ts";

/** Slack's own status API. */
interface Current {
  active_incidents: {
    id: number;
    title: string;
    type: string;
    status: string;
    url?: string;
    date_created: string;
    date_updated?: string;
    services?: string[];
    notes?: { date_created: string; body: string }[];
  }[];
}

const TYPE: Record<string, Status> = { outage: "major_outage", incident: "partial_outage", notice: "degraded" };

export const slack: StatusSource = async (_config, http) => {
  const data = await http.json<Current>("https://slack-status.com/api/v2.0.0/current");
  const incidents = data.active_incidents.map((i) =>
    incident({
      id: String(i.id),
      title: i.title,
      status: i.status,
      impact: TYPE[i.type] ?? "degraded",
      url: i.url,
      components: i.services ?? [],
      startedAt: iso(i.date_created),
      updatedAt: i.date_updated ? iso(i.date_updated) : undefined,
      updates: (i.notes ?? []).map((n) => ({ at: iso(n.date_created), status: "update", body: plain(n.body) })),
    }),
  );

  return {
    status: worst(incidents.map((i) => i.impact)),
    summary: incidents.length ? `${incidents.length} active incident(s)` : "All systems operational",
    components: incidents.flatMap((i) => i.components.map((name) => ({ name, status: i.impact }))),
    incidents,
  };
};
