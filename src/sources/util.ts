import type { Status } from "../domain/status.ts";
import type { Incident, IncidentUpdate } from "../domain/types.ts";

export function requireString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (typeof value !== "string" || !value) throw new Error(`config.${key} is required`);
  return value;
}

/** Joins a base URL and a path without doubling slashes. */
export const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;

export const iso = (value: string | number | Date | null | undefined): string => {
  if (value === null || value === undefined || value === "") return new Date().toISOString();
  const date = typeof value === "string" && /^\d+$/.test(value) ? new Date(Number(value) * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Vendor bodies are often HTML or padded markdown; agents only need the words. */
export function plain(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|\w+);/g, (match, code: string) =>
      code.startsWith("#") ? String.fromCharCode(Number(code.slice(1))) : (ENTITIES[code] ?? match),
    )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export const newestFirst = (updates: IncidentUpdate[]) => updates.sort((a, b) => b.at.localeCompare(a.at));

export function incident(fields: Omit<Incident, "updatedAt" | "components" | "updates"> & Partial<Incident>): Incident {
  const updates = newestFirst(fields.updates ?? []);
  return {
    components: [],
    ...fields,
    updates,
    updatedAt: fields.updatedAt ?? updates[0]?.at ?? fields.startedAt,
  };
}

/** Maps vendor wording to our scale by keyword. Used where vendors have no fixed enum. */
export function statusFromWords(text: string, fallback: Status = "degraded"): Status {
  const t = text.toLowerCase();
  if (/maintenance/.test(t)) return "maintenance";
  if (/partial/.test(t)) return "partial_outage";
  if (/major|outage|down\b|unavailable|disruption/.test(t)) return "major_outage";
  if (/degrad|elevated|latency|slow|delay|intermittent/.test(t)) return "degraded";
  return fallback;
}
