import type { Snapshot } from "./types.ts";

const MAX_COMPONENTS = 50;
const MAX_UPDATES = 20;
const MAX_BODY = 2000;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * When the current status began: the earliest active incident that has an impact, so an
 * outage first seen mid-way is dated from its real start, not from our first poll.
 */
export function statusSince(snapshot: Snapshot, now = new Date().toISOString()): string {
  if (snapshot.status === "operational") return now;
  const starts = snapshot.incidents.filter((i) => i.impact !== "operational").map((i) => i.startedAt);
  return starts.length ? starts.reduce((a, b) => (a < b ? a : b)) : now;
}

/** Bounds what one provider can put in the database and in an agent's context. */
export function normalize(snapshot: Snapshot): Snapshot {
  return {
    status: snapshot.status,
    summary: clip(snapshot.summary, 300),
    components: snapshot.components.slice(0, MAX_COMPONENTS),
    incidents: snapshot.incidents.map((incident) => ({
      ...incident,
      title: clip(incident.title, 300),
      components: incident.components.slice(0, MAX_COMPONENTS),
      updates: incident.updates.slice(0, MAX_UPDATES).map((u) => ({ ...u, body: clip(u.body, MAX_BODY) })),
    })),
  };
}
