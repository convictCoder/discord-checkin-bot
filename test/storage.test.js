import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { MemoryStore, SupabaseStore, canUse, createStore } from "../storage.js";
import { StandupCopilot } from "../standup.js";

const analysis = { completed: ["Tests"], inProgress: [], blockers: [], commitments: [{ task: "Ship", targetTimeframe: "Friday" }], riskLevel: "LOW" };
const entry = { guildId: "guild", channelId: "channel", userId: "user", user: "User", day: "2026-11-02", raw: "Ship Friday", analysis };
function fakeApi(responses) {
  const requests = [];
  const client = createClient("https://test.supabase.co", "server-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (url, options) => {
      requests.push({ url: new URL(url), options });
      const value = responses.shift();
      return new Response(JSON.stringify(value.body), { status: value.status || 200, headers: { "Content-Type": "application/json" } });
    } },
  });
  return { store: new SupabaseStore(client), requests };
}

test("tier matrix rejects inactive/invalid tiers and gates digests", () => {
  for (const tier of ["free", "pro", "enterprise"]) {
    assert.equal(canUse({ tier, active: true }, "intake"), true);
    assert.equal(canUse({ tier, active: true }, "digest"), tier !== "free");
    assert.equal(canUse({ tier, active: false }, "intake"), false);
    assert.equal(canUse({ tier, active: false }, "digest"), false);
  }
  assert.equal(canUse(null, "intake"), false);
  assert.equal(canUse({ tier: "bogus", active: true }, "intake"), false);
});

test("production storage defaults to Supabase and fails on missing configuration", () => {
  assert.throws(() => createStore({}), /requires SUPABASE_URL/);
  assert.throws(() => createStore({ STANDUP_STORAGE: "typo" }), /must be/);
  assert.ok(createStore({ STANDUP_STORAGE: "memory" }) instanceof MemoryStore);
});

test("Supabase writes daily unique records including commitments", async () => {
  const { store, requests } = fakeApi([{ body: null }]);
  await store.saveEntry(entry);
  const request = requests[0];
  assert.equal(request.url.pathname, "/rest/v1/standup_records");
  assert.equal(request.url.searchParams.get("on_conflict"), "guild_id,channel_id,standup_day,discord_user_id");
  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.commitments, analysis.commitments);
  assert.equal(body.standup_day, entry.day);
  assert.equal(body.discord_user_id, entry.userId);
});

test("daily entries are filtered in SQL and hydrated from saved analysis", async () => {
  const { store, requests } = fakeApi([{ body: [{ discord_user_id: "user", guild_id: "guild", user_tag: "User", raw_message: "Ship Friday", completed: ["Tests"], in_progress: [], blockers: [], commitments: analysis.commitments, risk_level: "LOW" }] }]);
  const entries = await store.dailyEntries("guild", "channel", entry.day);
  assert.deepEqual(entries[0].analysis, analysis);
  assert.equal(requests[0].url.searchParams.get("guild_id"), "eq.guild");
  assert.equal(requests[0].url.searchParams.get("channel_id"), "eq.channel");
  assert.equal(requests[0].url.searchParams.get("standup_day"), "eq.2026-11-02");
});

test("missing subscription becomes Free but database errors never bypass checks", async () => {
  const missing = fakeApi([{ body: null }]);
  assert.deepEqual(await missing.store.subscription("guild"), { tier: "free", active: true });
  const failure = fakeApi([{ body: { code: "42501", message: "private details" }, status: 403 }]);
  await assert.rejects(failure.store.subscription("guild"), error => error.message.includes("42501") && !error.message.includes("private details"));
});

function copilot(store) {
  const sent = [], replies = [];
  let parseCalls = 0, digestCalls = 0;
  const client = { channels: { fetch: async () => ({ guildId: "guild", isTextBased: () => true, send: async p => sent.push(p) }) } };
  const options = { channelId: "channel", store, timezone: "UTC", now: () => new Date("2026-11-02T10:00:00Z"),
    parse: async () => { parseCalls++; return analysis; }, digest: async () => { digestCalls++; return "Digest"; } };
  const bot = new StandupCopilot(client, options);
  const message = { guildId: "guild", channelId: "channel", content: "!standup Ship Friday",
    author: { id: "user", username: "User", bot: false, displayAvatarURL: () => "https://example.com/a.png" },
    reply: async p => replies.push(p) };
  return { bot, options, client, message, replies, sent, counts: () => ({ parseCalls, digestCalls }) };
}

test("new bot instance recovers today's thread and digests stored entries", async () => {
  const store = new MemoryStore();
  const f = copilot(store);
  await f.bot.handleMessage(f.message);
  await store.saveSession({ guildId: "guild", channelId: "channel", day: entry.day, threadId: "thread" });
  const restarted = new StandupCopilot(f.client, f.options);
  await restarted.restore();
  assert.equal(restarted.threads.get(entry.day), "thread");
  assert.equal(restarted.entries.size, 0);
  await restarted.publishDigest();
  assert.equal(f.sent.length, 1);
});

test("Free receives intake but no digest; inactive subscriptions make no AI calls", async () => {
  const store = new MemoryStore();
  store.subscription = async () => ({ tier: "free", active: true });
  const f = copilot(store);
  await f.bot.handleMessage(f.message);
  await f.bot.publishDigest();
  assert.deepEqual(f.counts(), { parseCalls: 1, digestCalls: 0 });
  store.subscription = async () => ({ tier: "pro", active: false });
  await f.bot.handleMessage(f.message);
  await f.bot.publishDigest();
  assert.deepEqual(f.counts(), { parseCalls: 1, digestCalls: 0 });
  assert.match(f.replies.at(-1).content, /disabled/);
});

test("save failure never acknowledges success or feeds an in-memory digest", async () => {
  const store = new MemoryStore();
  store.saveEntry = async () => { throw new Error("Database unavailable"); };
  const f = copilot(store);
  await f.bot.handleMessage(f.message);
  assert.match(f.replies[0].content, /Could not analyze or save/);
  assert.equal(f.bot.entries.size, 0);
  assert.equal(f.bot.pending.size, 0);
  await f.bot.publishDigest();
  assert.equal(f.sent.length, 0);
});
