import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderStatus, StatusReader } from "../src/domain/ports.ts";
import { createServer } from "../src/mcp/server.ts";

process.env.MCP_USE_ANONYMIZED_TELEMETRY = "false";

const provider = (id: string, category: string, status: ProviderStatus["status"]): ProviderStatus => ({
  id, name: id, category, url: `https://status.${id}.com`, source: "statuspage", status, summary: "",
  components: [], checkedAt: new Date().toISOString(), changedAt: null, error: null, errorAt: null,
});

const providers = [provider("resend", "email", "operational"), provider("railway", "hosting", "major_outage")];
const reader: StatusReader = {
  resolve: async (names) => new Map(names.map((n) => [n, providers.find((p) => p.id === n)?.id ?? null])),
  statuses: async (ids) => providers.filter((p) => !ids || ids.includes(p.id)),
  incidents: async () => [],
  changes: async () => [],
  search: async (_query, category) => providers.filter((p) => !category || p.category === category),
  health: async () => ({ lastCheckedAt: new Date().toISOString(), providers: providers.length }),
};

const server = createServer(reader, { host: "127.0.0.1", port: 0, allowedHosts: [], categories: ["email", "hosting"] });

async function call(name: string, args: Record<string, unknown>) {
  const res = await server.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
  );
  const body = await res.text();
  const json = JSON.parse(body.split("\n").find((l) => l.startsWith("data: "))?.slice(6) ?? body);
  return json.result as { isError?: boolean; content: { text: string }[] };
}

test("list_incidents rejects an unknown category instead of reporting all clear", async () => {
  const result = await call("list_incidents", { category: "nonexistent" });
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /Unknown category "nonexistent"\. Categories: email, hosting/);
});

test("categories match case-insensitively", async () => {
  const result = await call("list_incidents", { category: "HOSTING" });
  assert.match(result.content[0]!.text, /1 of 1 providers have problems/);
  assert.match((await call("search_providers", { category: "Email" })).content[0]!.text, /^resend/);
});
