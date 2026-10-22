import type { Status } from "./status.ts";

export type SourceKind =
  | "statuspage"
  | "statusio"
  | "instatus"
  | "betterstack"
  | "google"
  | "aws"
  | "feed"
  | "railway"
  | "slack"
  | "heroku"
  | "probe";

/** A provider we track, and how to read its status. */
export interface Provider {
  id: string;
  name: string;
  category: string;
  /** Human-facing status page. */
  url: string;
  source: SourceKind;
  /** Source-specific settings, e.g. `{ url }` or `{ pageId }`. */
  config: Record<string, unknown>;
  /** Other names agents may use ("gh", "claude"). */
  aliases: string[];
  intervalSec: number;
}

export interface IncidentUpdate {
  at: string;
  status: string;
  body: string;
}

export interface Incident {
  id: string;
  title: string;
  /** Vendor wording, e.g. investigating / identified / monitoring. */
  status: string;
  impact: Status;
  url?: string;
  components: string[];
  /** Newest first. */
  updates: IncidentUpdate[];
  startedAt: string;
  updatedAt: string;
}

export interface Component {
  name: string;
  status: Status;
}

/** What a source reports right now. Only active incidents and non-operational components. */
export interface Snapshot {
  status: Status;
  summary: string;
  components: Component[];
  incidents: Incident[];
}
