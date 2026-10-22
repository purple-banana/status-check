import type { StatusSource } from "../domain/ports.ts";
import { worst, type Status } from "../domain/status.ts";
import { incident, iso, plain } from "./util.ts";

/** Heroku's own status API. */
interface HkEvent {
  id: number;
  title: string;
  state: string;
  created_at: string;
  updated_at?: string;
  full_url?: string;
  systems?: { name: string }[];
  updates?: { created_at: string; contents: string; update_type: string }[];
}

interface Current {
  status: { system: string; status: string }[];
  incidents?: HkEvent[];
  scheduled?: HkEvent[];
}

const COLOR: Record<string, Status> = { green: "operational", yellow: "degraded", red: "major_outage", blue: "maintenance" };

export const heroku: StatusSource = async (_config, http) => {
  const data = await http.json<Current>("https://status.heroku.com/api/v4/current-status");
  const components = data.status
    .filter((s) => s.status !== "green")
    .map((s) => ({ name: s.system, status: COLOR[s.status] ?? "degraded" }));

  const toIncident = (e: HkEvent, impact: Status) =>
    incident({
      id: String(e.id),
      title: e.title,
      status: e.state,
      impact,
      url: e.full_url,
      components: (e.systems ?? []).map((s) => s.name),
      startedAt: iso(e.created_at),
      updatedAt: e.updated_at ? iso(e.updated_at) : undefined,
      updates: (e.updates ?? []).map((u) => ({ at: iso(u.created_at), status: u.update_type, body: plain(u.contents) })),
    });

  const status = worst(components.map((c) => c.status));
  const incidents = [
    ...(data.incidents ?? []).map((e) => toIncident(e, status === "operational" ? "degraded" : status)),
    ...(data.scheduled ?? []).filter((e) => e.state === "in_progress").map((e) => toIncident(e, "maintenance")),
  ];

  return {
    status: worst([status, ...incidents.map((i) => i.impact)]),
    summary: components.length ? components.map((c) => `${c.name}: ${c.status}`).join(", ") : "All systems operational",
    components,
    incidents,
  };
};
