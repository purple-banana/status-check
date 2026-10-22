import type { StatusSource } from "../domain/ports.ts";
import type { Status } from "../domain/status.ts";
import type { Component } from "../domain/types.ts";
import { incident, iso, plain, requireString } from "./util.ts";

/** status.io public API. The page id is in the status page HTML (`statuspage_id`). */
interface Response {
  result: {
    status_overall: { status: string; status_code: number };
    status?: { name: string; status_code: number; containers?: { name: string; status_code: number }[] }[];
    incidents?: SioEvent[];
    maintenance?: { active?: SioEvent[] };
  };
}

interface SioEvent {
  _id?: string;
  id?: string;
  name: string;
  datetime_open?: string;
  datetime_planned_start?: string;
  messages?: { details: string; datetime: string; state?: number; status?: number }[];
  components_affected?: { name: string }[];
}

const CODE: Record<number, Status> = {
  100: "operational",
  200: "maintenance",
  300: "degraded",
  400: "partial_outage",
  500: "major_outage",
  600: "partial_outage",
};

const STATE: Record<number, string> = { 100: "investigating", 200: "identified", 300: "monitoring" };

const status = (code: number | undefined): Status => (code === undefined ? "degraded" : (CODE[code] ?? "degraded"));

export const statusio: StatusSource = async (config, http) => {
  const pageId = requireString(config, "pageId");
  const { result } = await http.json<Response>(`https://api.status.io/1.0/status/${pageId}`);

  const components: Component[] = (result.status ?? []).flatMap((c) =>
    (c.containers?.length ? c.containers.map((x) => ({ name: `${c.name} / ${x.name}`, code: x.status_code })) : [{ name: c.name, code: c.status_code }])
      .filter((x) => x.code !== 100)
      .map((x) => ({ name: x.name, status: status(x.code) })),
  );

  const toIncident = (e: SioEvent, maintenance: boolean) => {
    const latest = e.messages?.at(-1);
    return incident({
      id: e.id ?? e._id ?? e.name,
      title: e.name,
      status: maintenance ? "in_progress" : (STATE[latest?.state ?? 0] ?? "investigating"),
      impact: maintenance ? "maintenance" : status(latest?.status),
      components: (e.components_affected ?? []).map((c) => c.name),
      startedAt: iso(e.datetime_open ?? e.datetime_planned_start),
      updates: (e.messages ?? []).map((m) => ({
        at: iso(m.datetime),
        status: STATE[m.state ?? 0] ?? "update",
        body: plain(m.details),
      })),
    });
  };

  return {
    status: status(result.status_overall.status_code),
    summary: result.status_overall.status,
    components,
    incidents: [
      ...(result.incidents ?? []).map((e) => toIncident(e, false)),
      ...(result.maintenance?.active ?? []).map((e) => toIncident(e, true)),
    ],
  };
};
