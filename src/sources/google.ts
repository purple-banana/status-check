import type { StatusSource } from "../domain/ports.ts";
import { capAt, worst, type Status } from "../domain/status.ts";
import { incident, iso, plain, requireString } from "./util.ts";

/**
 * Google's `incidents.json` (Google Cloud, Firebase, Workspace). The feed holds the full
 * history; incidents without an `end` are active.
 */
interface GIncident {
  id: string;
  begin: string;
  end?: string;
  modified?: string;
  external_desc: string;
  status_impact: string;
  uri?: string;
  affected_products?: { title: string }[];
  updates?: { when: string; text: string; status: string }[];
}

const IMPACT: Record<string, Status> = {
  SERVICE_INFORMATION: "degraded",
  SERVICE_DISRUPTION: "partial_outage",
  SERVICE_OUTAGE: "major_outage",
};

export const google: StatusSource = async (config, http) => {
  const url = requireString(config, "url");
  const active = (await http.json<GIncident[]>(url)).filter((i) => !i.end);

  const incidents = active.map((i) =>
    incident({
      id: i.id,
      title: i.external_desc,
      status: i.updates?.[0]?.status.toLowerCase() ?? "ongoing",
      impact: IMPACT[i.status_impact] ?? "degraded",
      url: i.uri ? new URL(i.uri, url).href : undefined,
      components: (i.affected_products ?? []).map((p) => p.title),
      startedAt: iso(i.begin),
      updatedAt: i.modified ? iso(i.modified) : undefined,
      updates: (i.updates ?? []).map((u) => ({ at: iso(u.when), status: u.status.toLowerCase(), body: plain(u.text) })),
    }),
  );

  // Hundreds of products: one product's outage is a partial outage of the platform.
  return {
    status: capAt(worst(incidents.map((i) => i.impact)), "partial_outage"),
    summary: incidents.length ? `${incidents.length} active incident(s)` : "All services available",
    components: [...new Set(incidents.flatMap((i) => i.components))].map((name) => ({
      name,
      status: worst(incidents.filter((i) => i.components.includes(name)).map((i) => i.impact)),
    })),
    incidents,
  };
};
