import type { StatusSource } from "../domain/ports.ts";
import type { Status } from "../domain/status.ts";
import { incident, iso, join, plain, requireString } from "./util.ts";

/** Better Stack (Better Uptime) status pages: `index.json`, a JSON:API document. */
interface Doc {
  data: { attributes: { aggregate_state: string } };
  included?: Resource[];
}

interface Resource {
  id: string;
  type: string;
  attributes: Record<string, any>;
  relationships?: Record<string, { data?: { id: string; type: string }[] }>;
}

const STATE: Record<string, Status> = {
  operational: "operational",
  degraded: "degraded",
  downtime: "major_outage",
  maintenance: "maintenance",
};

const SUMMARY: Record<string, string> = {
  operational: "All systems operational",
  degraded: "Degraded performance",
  downtime: "Downtime",
  maintenance: "Maintenance",
};

export const betterstack: StatusSource = async (config, http) => {
  const base = requireString(config, "url");
  const doc = await http.json<Doc>(join(base, "index.json"));
  const included = doc.included ?? [];
  const byId = new Map(included.map((r) => [`${r.type}:${r.id}`, r]));
  const now = Date.now();
  const state = doc.data.attributes.aggregate_state;

  const components = included
    .filter((r) => r.type === "status_page_resource" && STATE[r.attributes.status] && r.attributes.status !== "operational")
    .map((r) => ({ name: String(r.attributes.public_name), status: STATE[r.attributes.status]! }));

  const incidents = included
    .filter((r) => {
      const a = r.attributes;
      return (
        r.type === "status_report" &&
        a.aggregate_state !== "resolved" &&
        Date.parse(a.starts_at) <= now &&
        (!a.ends_at || Date.parse(a.ends_at) > now)
      );
    })
    .map((r) =>
      incident({
        id: r.id,
        title: String(r.attributes.title),
        status: String(r.attributes.aggregate_state),
        impact: r.attributes.report_type === "maintenance" ? "maintenance" : (STATE[r.attributes.aggregate_state] ?? "degraded"),
        startedAt: iso(r.attributes.starts_at),
        updates: (r.relationships?.status_updates?.data ?? [])
          .map((ref) => byId.get(`${ref.type}:${ref.id}`)?.attributes)
          .filter((u) => u !== undefined)
          .map((u) => ({ at: iso(u.published_at), status: "update", body: plain(u.message) })),
      }),
    );

  return {
    status: STATE[state] ?? "unknown",
    summary: SUMMARY[state] ?? state,
    components,
    incidents,
  };
};
