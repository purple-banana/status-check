export const STATUSES = [
  "operational",
  "maintenance",
  "degraded",
  "partial_outage",
  "major_outage",
  "unknown",
] as const;

export type Status = (typeof STATUSES)[number];

const SEVERITY: Record<Status, number> = {
  unknown: -1,
  operational: 0,
  maintenance: 1,
  degraded: 2,
  partial_outage: 3,
  major_outage: 4,
};

export const severity = (status: Status): number => SEVERITY[status];

/** The most severe of the given statuses; `fallback` when the list is empty. */
export function worst(statuses: Iterable<Status>, fallback: Status = "operational"): Status {
  let result: Status | undefined;
  for (const status of statuses) {
    if (result === undefined || SEVERITY[status] > SEVERITY[result]) result = status;
  }
  return result ?? fallback;
}

export function capAt(status: Status, max: Status): Status {
  return SEVERITY[status] > SEVERITY[max] ? max : status;
}
