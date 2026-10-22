import { XMLParser } from "fast-xml-parser";
import type { StatusSource } from "../domain/ports.ts";
import { worst } from "../domain/status.ts";
import { incident, iso, plain, requireString, statusFromWords } from "./util.ts";

/**
 * Generic RSS/Atom incident feed, for vendors without a structured API. Feeds carry no
 * status field, so an entry counts as active when it was updated within `activeHours`,
 * its latest text does not say it is resolved, and it is not a maintenance announcement.
 * Entries whose wording names no impact are kept as notices without changing the status.
 */
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const RESOLVED = /\b(resolved|completed|fixed|restored|recovered|closed)\b/i;
const ANNOUNCEMENT = /\bscheduled\b/i;

type Node = string | { "#text"?: string; href?: string } | undefined;
const text = (node: Node | Node[]): string => {
  const n = Array.isArray(node) ? node[0] : node;
  return typeof n === "object" ? (n["#text"] ?? n.href ?? "") : String(n ?? "");
};
const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

export const feed: StatusSource = async (config, http) => {
  const url = requireString(config, "url");
  const activeHours = Number(config.activeHours ?? 24);
  const xml = parser.parse(await http.text(url));
  const cutoff = Date.now() - activeHours * 3_600_000;

  const entries = [...list(xml.rss?.channel?.item), ...list(xml.feed?.entry)].map((e: Record<string, Node | Node[]>) => {
    const title = plain(text(e.title));
    const body = plain(text(e.description ?? e.content ?? e.summary));
    return {
      id: text(e.guid ?? e.id) || title,
      title,
      body,
      link: text(e.link),
      at: iso(text(e.updated ?? e.pubDate ?? e.published)),
    };
  });

  const incidents = entries
    .filter((e) => Date.parse(e.at) >= cutoff && !ANNOUNCEMENT.test(e.title) && !RESOLVED.test(`${e.title} ${e.body.slice(0, 300)}`))
    .map((e) =>
      incident({
        id: e.id,
        title: e.title,
        status: "ongoing",
        impact: statusFromWords(`${e.title} ${e.body.slice(0, 300)}`, "operational"),
        url: e.link || undefined,
        startedAt: e.at,
        updates: [{ at: e.at, status: "update", body: e.body }],
      }),
    );

  return {
    status: worst(incidents.map((i) => i.impact)),
    summary: incidents.length ? `${incidents.length} active incident(s)` : "No active incidents",
    components: [],
    incidents,
  };
};
