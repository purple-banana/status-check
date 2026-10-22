import type { StatusSource } from "../domain/ports.ts";
import { capAt, worst, type Status } from "../domain/status.ts";
import { incident, iso, plain } from "./util.ts";

/** AWS Health Dashboard public events (UTF-16 JSON, decoded by the HTTP client). */
interface AwsEvent {
  arn: string;
  date: string;
  region_name?: string;
  status: string;
  service_name: string;
  summary: string;
  event_log?: { summary: string; message: string; status: string | number; timestamp: string | number }[];
  impacted_services?: Record<string, { service_name: string; current: string }>;
}

const URL = "https://health.aws.amazon.com/public/currentevents";
const LEVEL: Record<string, Status> = { "1": "degraded", "2": "partial_outage", "3": "major_outage" };

export const aws: StatusSource = async (_config, http) => {
  const events = (await http.json<AwsEvent[]>(URL)).filter((e) => LEVEL[e.status]);

  const incidents = events.map((e) => {
    const where = e.region_name ? ` (${e.region_name})` : "";
    return incident({
      id: e.arn,
      title: `${e.service_name}${where}: ${e.summary}`,
      status: "ongoing",
      impact: LEVEL[e.status]!,
      url: "https://health.aws.amazon.com/health/status",
      components: Object.values(e.impacted_services ?? {})
        .filter((s) => LEVEL[s.current])
        .map((s) => `${s.service_name}${where}`),
      startedAt: iso(e.date),
      updates: (e.event_log ?? []).map((u) => ({
        at: iso(String(u.timestamp)),
        status: u.summary,
        body: plain(u.message),
      })),
    });
  });

  // Every event is scoped to a service or region, so AWS as a whole is never more than partially down.
  return {
    status: capAt(worst(incidents.map((i) => i.impact)), "partial_outage"),
    summary: incidents.length ? `${incidents.length} active event(s)` : "All services operating normally",
    components: incidents.flatMap((i) => i.components.map((name) => ({ name, status: i.impact }))),
    incidents,
  };
};
