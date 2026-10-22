import type { ProviderStatus, StatusChange, StoredIncident } from "../domain/ports.ts";

/** Compact plain text for agents: one fact per line, newest first, no JSON noise. */

const STALE_MS = 5 * 60_000;

export const time = (iso: string | null) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "never");

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 120) return `${minutes} min ago`;
  if (minutes < 72 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const firstLine = (text: string, max = 280) => {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** Warns when we could not read the vendor's feed recently. */
export function freshness(p: ProviderStatus): string | null {
  if (!p.checkedAt) return p.error ? `status feed unreachable: ${p.error}` : "not checked yet";
  if (p.errorAt && p.errorAt > p.checkedAt) return `status feed unreachable since ${ago(p.errorAt)}, showing data from ${ago(p.checkedAt)}`;
  if (Date.now() - Date.parse(p.checkedAt) > STALE_MS) return `last checked ${ago(p.checkedAt)}`;
  return null;
}

export function headline(p: ProviderStatus): string {
  const since = p.status !== "operational" && p.changedAt ? ` since ${time(p.changedAt)}` : "";
  const warning = freshness(p);
  const synthetic = p.source === "probe" ? " [synthetic check, no official feed]" : "";
  return `${p.name} (${p.id}): ${p.status.toUpperCase()}${since} — ${p.summary}${synthetic}${warning ? ` ⚠ ${warning}` : ""}`;
}

export function incidentLine(i: StoredIncident, updates = 1): string {
  const head = `• ${i.title} [${i.impact}, ${i.resolvedAt ? `resolved ${time(i.resolvedAt)}` : i.status}] started ${time(i.startedAt)}${
    i.components.length ? ` · affects: ${i.components.slice(0, 8).join(", ")}${i.components.length > 8 ? ` +${i.components.length - 8}` : ""}` : ""
  }${i.url ? ` · ${i.url}` : ""}`;
  const lines = i.updates.slice(0, updates).map((u) => `    ${time(u.at)} ${u.status}: ${updates === 1 ? firstLine(u.body) : u.body.replace(/\n/g, "\n      ")}`);
  return [head, ...lines].join("\n");
}

export function detail(p: ProviderStatus, incidents: StoredIncident[]): string {
  const lines = [headline(p), `Status page: ${p.url} · checked ${ago(p.checkedAt)}`];
  if (p.components.length) {
    lines.push(`Affected components (${p.components.length}):`);
    lines.push(...p.components.slice(0, 25).map((c) => `  - ${c.name}: ${c.status}`));
  }
  lines.push(incidents.length ? `Active incidents (${incidents.length}):` : "No active incidents.");
  lines.push(...incidents.map((i) => incidentLine(i, 5)));
  return lines.join("\n");
}

export function history(p: ProviderStatus, changes: StatusChange[], incidents: StoredIncident[], days: number): string {
  const lines = [headline(p), `Last ${days} days (tracked since this server started polling):`];
  lines.push(changes.length ? "Status changes:" : "No status changes recorded.");
  lines.push(...changes.map((c) => `  ${time(c.at)} → ${c.status}`));
  lines.push(incidents.length ? `Incidents (${incidents.length}):` : "No incidents recorded.");
  lines.push(...incidents.map((i) => incidentLine(i)));
  return lines.join("\n");
}
