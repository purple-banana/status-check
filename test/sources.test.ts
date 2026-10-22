import assert from "node:assert/strict";
import { test } from "node:test";
import type { Http } from "../src/domain/ports.ts";
import { statusSince } from "../src/domain/snapshot.ts";
import { capAt, worst } from "../src/domain/status.ts";
import { feed } from "../src/sources/feed.ts";
import { instatus } from "../src/sources/instatus.ts";
import { railway } from "../src/sources/railway.ts";
import { statuspage } from "../src/sources/statuspage.ts";

const fakeHttp = (body: unknown): Http => ({
  json: async () => body as never,
  text: async () => String(body),
  probe: async () => ({ status: 200, ms: 1 }),
});

test("worst and capAt order statuses by severity", () => {
  assert.equal(worst(["operational", "maintenance", "partial_outage", "degraded"]), "partial_outage");
  assert.equal(worst([]), "operational");
  assert.equal(capAt("major_outage", "partial_outage"), "partial_outage");
});

test("statuspage maps indicator, grouped components and incident updates", async () => {
  const snapshot = await statuspage(
    { url: "https://status.example.com" },
    fakeHttp({
      status: { indicator: "major", description: "Partial System Outage" },
      components: [
        { id: "g", name: "US East", status: "partial_outage", group: true },
        { id: "c", name: "Builds", status: "major_outage", group_id: "g" },
        { id: "d", name: "API", status: "operational" },
      ],
      incidents: [
        {
          id: "i1",
          name: "Builds failing",
          status: "identified",
          impact: "critical",
          created_at: "2026-10-21T07:24:00Z",
          incident_updates: [
            { status: "investigating", body: "Looking into it", created_at: "2026-10-21T07:24:00Z" },
            { status: "identified", body: "<p>Root cause &amp; fix</p>", created_at: "2026-10-21T08:00:00Z" },
          ],
        },
      ],
      scheduled_maintenances: [{ id: "m1", name: "Later", status: "scheduled", impact: "maintenance", created_at: "2026-10-21T00:00:00Z" }],
    }),
  );

  assert.equal(snapshot.status, "partial_outage");
  assert.deepEqual(snapshot.components, [{ name: "US East / Builds", status: "major_outage" }]);
  assert.equal(snapshot.incidents.length, 1, "scheduled maintenance is not active");
  assert.equal(snapshot.incidents[0]!.impact, "major_outage");
  assert.equal(snapshot.incidents[0]!.updates[0]!.body, "Root cause & fix", "newest update first, HTML stripped");
});

test("railway reads active incidents with component impact", async () => {
  const snapshot = await railway(
    {},
    fakeHttp({
      activeIncidents: [
        {
          id: "x",
          slug: "QH8L8B3E",
          title: "Railway Platform Outage",
          status: "IDENTIFIED",
          createdAt: "2026-10-21T07:24:24Z",
          components: [{ name: "Builds", groupName: "US West", impact: "MAJOR_OUTAGE" }],
          updates: [{ status: "IDENTIFIED", message: "Builds paused", createdAt: "2026-10-21T08:00:00Z" }],
        },
      ],
      maintenances: [],
    }),
  );

  assert.equal(snapshot.status, "major_outage");
  assert.equal(snapshot.incidents[0]!.url, "https://status.railway.com/incident/QH8L8B3E");
  assert.equal(statusSince(snapshot), "2026-10-21T07:24:24.000Z", "dated from the incident, not the poll");
});

test("feed keeps recent unresolved entries and skips announcements", async () => {
  const now = new Date().toUTCString();
  const xml = `<rss><channel>
    <item><title>Partial outage in EU</title><pubDate>${now}</pubDate><description>Investigating</description></item>
    <item><title>Login errors</title><pubDate>${now}</pubDate><description>This incident has been resolved.</description></item>
    <item><title>Scheduled maintenance for payments</title><pubDate>${now}</pubDate></item>
    <item><title>Old outage</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const snapshot = await feed({ url: "https://example.com/rss" }, fakeHttp(xml));

  assert.deepEqual(snapshot.incidents.map((i) => i.title), ["Partial outage in EU"]);
  assert.equal(snapshot.status, "partial_outage");
});

test("instatus ignores maintenance windows that have not started", async () => {
  const update = { message: "Bancontact maintenance", createdAt: "2026-10-19T13:22:13Z" };
  const fixture = {
    page: { status: "UP" },
    activeMaintenances: [
      { id: "later", name: "Upcoming", start: "2999-01-01T00:00:00Z", status: "NOTSTARTEDYET", updatedAt: "2026-10-21T22:00:00Z", lastUpdate: update },
      { id: "now", name: "Running", start: "2026-10-22T10:00:00Z", status: "INPROGRESS", updatedAt: "2026-10-22T10:00:00Z", lastUpdate: update },
    ],
  };
  const first = await instatus({ url: "https://status.example.com" }, fakeHttp(fixture));
  const second = await instatus({ url: "https://status.example.com" }, fakeHttp(fixture));

  assert.deepEqual(first.incidents.map((i) => i.id), ["now"]);
  assert.equal(first.incidents[0]!.startedAt, "2026-10-22T10:00:00.000Z");
  assert.equal(first.incidents[0]!.updates[0]!.body, "Bancontact maintenance");
  assert.deepEqual(first, second, "same feed, same snapshot: no write every poll");
});
