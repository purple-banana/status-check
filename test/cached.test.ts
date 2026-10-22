import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderStatus, StatusReader, StoredIncident } from "../src/domain/ports.ts";
import { cachedReader } from "../src/store/cached.ts";

const status = (id: string, category: string): ProviderStatus => ({
  id, name: id, category, url: "", source: "statuspage", status: "operational", summary: "",
  components: [], checkedAt: null, changedAt: null, error: null, errorAt: null,
});
const incident = (providerId: string): StoredIncident => ({
  providerId, id: `${providerId}-1`, title: "", status: "investigating", impact: "degraded",
  components: [], updates: [], startedAt: "", updatedAt: "", resolvedAt: null,
});

function fakeReader() {
  const calls = { load: 0, history: 0, search: 0 };
  let fail = false;
  const reader: StatusReader = {
    resolve: async () => new Map(),
    changes: async () => [],
    statuses: async () => {
      if (fail) throw new Error("db down");
      calls.load++;
      return [status("railway", "hosting"), status("resend", "email")];
    },
    incidents: async (filter) => {
      if (!filter.active) calls.history++;
      return [incident("railway")];
    },
    search: async () => {
      calls.search++;
      return [];
    },
    health: async () => ({ lastCheckedAt: null, providers: 2 }),
  };
  return { reader, calls, setFail: (value: boolean) => (fail = value) };
}

test("current-state calls share one load per window, concurrent ones too", async () => {
  let clock = 0;
  const { reader, calls } = fakeReader();
  const cached = cachedReader(reader, 15_000, () => clock);

  await Promise.all([cached.statuses(), cached.statuses(["railway"]), cached.incidents({ active: true }), cached.health()]);
  await cached.search(undefined, "email");
  assert.equal(calls.load, 1);

  clock = 15_000;
  await cached.statuses();
  assert.equal(calls.load, 2, "reloads once the window passes");
});

test("filters come from the snapshot; history and name search go to the database", async () => {
  const { reader, calls } = fakeReader();
  const cached = cachedReader(reader, 15_000, () => 0);

  assert.deepEqual((await cached.statuses(["resend"])).map((p) => p.id), ["resend"]);
  assert.deepEqual((await cached.search(undefined, "hosting")).map((p) => p.id), ["railway"]);
  assert.deepEqual(await cached.incidents({ active: true, providerIds: ["resend"] }), []);

  await cached.incidents({ providerIds: ["railway"], sinceDays: 7 });
  await cached.search("rail");
  assert.deepEqual([calls.history, calls.search], [1, 1]);
});

test("a failed reload keeps serving the last snapshot", async () => {
  let clock = 0;
  const { reader, setFail } = fakeReader();
  const cached = cachedReader(reader, 15_000, () => clock);

  await cached.statuses();
  setFail(true);
  clock = 20_000;
  assert.equal((await cached.statuses()).length, 2);
});
