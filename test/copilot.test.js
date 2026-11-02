import test from "node:test";
import assert from "node:assert/strict";
import { createAiService, validateAnalysis } from "../ai.js";
import { StandupCopilot, dayKey } from "../standup.js";

const analysis = () => ({ completed: ["Tests shipped"], inProgress: ["Release"], blockers: ["Access"], commitments: [{ task: "Ship", targetTimeframe: "Friday" }], riskLevel: "HIGH" });

function fixture() {
  const sent = [];
  const parsed = [];
  const channel = { guildId: "guild", isTextBased: () => true, send: async payload => {
    sent.push(payload);
    return { startThread: async () => ({ id: "thread" }) };
  } };
  let date = new Date("2026-11-02T18:00:00Z");
  const bot = new StandupCopilot({ channels: { fetch: async () => channel } }, {
    channelId: "channel", now: () => date,
    parse: async (...args) => { parsed.push(args); return analysis(); },
    digest: async entries => { parsed.push(entries); return "Digest"; },
  });
  const replies = [];
  const message = (content = "!standup Done tests") => ({
    content, channelId: "channel", guildId: "guild",
    author: { bot: false, id: "user", username: "User", displayAvatarURL: () => "https://example.com/avatar.png" },
    reply: async payload => replies.push(payload),
  });
  return { bot, parsed, sent, replies, message, channel, setDate: value => { date = new Date(value); } };
}

test("Gemini uses structured schema and validates parsed results", async () => {
  let request;
  const service = createAiService({ client: { models: { generateContent: async input => {
    request = input;
    return { text: JSON.stringify(analysis()) };
  } } } });
  assert.equal((await service.parseStandupResponse("User", "Ship Friday")).riskLevel, "HIGH");
  assert.equal(request.config.responseMimeType, "application/json");
  assert.ok(request.config.responseSchema.required.includes("commitments"));
  assert.match(request.contents, /Ship Friday/);
});

test("malformed AI fields, JSON and empty digests fail safely", async () => {
  assert.throws(() => validateAnalysis({ ...analysis(), blockers: "oops" }));
  assert.throws(() => validateAnalysis({ ...analysis(), riskLevel: "CRITICAL" }));
  assert.throws(() => validateAnalysis({ ...analysis(), commitments: [null] }));
  const service = createAiService({ client: { models: { generateContent: async () => ({ text: "" }) } } });
  await assert.rejects(service.parseStandupResponse("u", "r"));
  await assert.rejects(service.generateDailyDigest([]), /Empty/);
});

test("channel submissions replace prior updates and show commitments", async () => {
  const f = fixture();
  await f.bot.handleMessage(f.message());
  await f.bot.handleMessage(f.message("!standup Updated release"));
  const entries = [...f.bot.entries.values()][0];
  assert.equal(entries.size, 1);
  assert.equal([...entries.values()][0].raw, "Updated release");
  assert.match(f.replies[0].embeds[0].toJSON().fields[3].value, /Friday/);
  assert.deepEqual(f.replies[0].allowedMentions.parse, []);
});

test("unrelated channels, DMs, bots and unrelated commands never invoke AI", async () => {
  const f = fixture();
  for (const overrides of [{ channelId: "other" }, { guildId: null }, { author: { bot: true } }]) {
    await f.bot.handleMessage({ ...f.message(), ...overrides });
  }
  await f.bot.handleMessage(f.message("hello"));
  await f.bot.handleMessage(f.message("!standupper something"));
  await f.bot.handleMessage(f.message("!standup"));
  assert.equal(f.parsed.length, 0);
  assert.equal(f.replies.length, 1);
});

test("today's created thread accepts plain updates and excludes stale threads", async () => {
  const f = fixture();
  await f.bot.prompt();
  await f.bot.handleMessage({ ...f.message("Finished tests"), channelId: "thread" });
  assert.equal(f.parsed.length, 1);
  f.setDate("2026-11-03T18:00:00Z");
  await f.bot.handleMessage({ ...f.message("Finished more"), channelId: "thread" });
  await f.bot.publishDigest();
  assert.equal(f.parsed.length, 1);
});

test("thread failure leaves command intake available", async () => {
  const f = fixture();
  f.channel.send = async () => ({ startThread: async () => { throw new Error("No permission"); } });
  await f.bot.prompt();
  await f.bot.handleMessage(f.message());
  assert.equal(f.replies.length, 1);
});

test("AI failure stores nothing and allows retry", async () => {
  const f = fixture();
  f.bot.parse = async () => { throw new Error("Unavailable"); };
  await f.bot.handleMessage(f.message());
  assert.equal(f.bot.entries.size, 0);
  assert.equal(f.bot.pending.size, 0);
  assert.match(f.replies[0].content, /try again/);
  f.bot.parse = async () => analysis();
  await f.bot.handleMessage(f.message());
  assert.equal(f.bot.entries.size, 1);
});

test("concurrent user updates are guarded", async () => {
  const f = fixture();
  let resolve;
  f.bot.parse = () => new Promise(done => { resolve = done; });
  const first = f.bot.handleMessage(f.message());
  await f.bot.handleMessage(f.message());
  assert.match(f.replies[0].content, /still being analyzed/);
  resolve(analysis());
  await first;
  assert.equal(f.bot.pending.size, 0);
});

test("day rollover during AI request does not leak old submissions", async () => {
  const f = fixture();
  f.bot.parse = async () => {
    f.setDate("2026-11-03T18:00:00Z");
    return analysis();
  };
  await f.bot.handleMessage(f.message());
  assert.equal(f.bot.entries.size, 0);
  assert.match(f.replies[0].content, /day changed/);
});

test("embed limits and high risk digest color are respected", async () => {
  const f = fixture();
  f.bot.parse = async () => ({ ...analysis(), completed: ["x".repeat(8000)] });
  f.bot.digest = async () => "x".repeat(8000);
  await f.bot.handleMessage(f.message());
  assert.equal(f.replies[0].embeds[0].toJSON().fields[0].value.length, 1024);
  await f.bot.publishDigest();
  const embed = f.sent[0].embeds[0].toJSON();
  assert.equal(embed.description.length, 4096);
  assert.equal(embed.color, 0xED4245);
});

test("calendar isolation respects timezone and daylight saving", () => {
  assert.equal(dayKey(new Date("2026-11-02T07:30:00Z"), "America/Los_Angeles"), "2026-11-01");
  assert.equal(dayKey(new Date("2026-11-02T08:30:00Z"), "America/Los_Angeles"), "2026-11-02");
});

test("schedules run weekdays at local 9 and 11 and cancel on cleanup", () => {
  const { bot } = fixture();
  bot.start();
  try {
    assert.equal(bot.jobs.length, 2);
    for (const [index, job] of bot.jobs.entries()) {
      const date = job.nextInvocation().toDate();
      const local = new Intl.DateTimeFormat("en-US", { timeZone: bot.timezone, hourCycle: "h23", hour: "numeric", weekday: "short" }).format(date);
      assert.match(local, new RegExp(index === 0 ? "09" : "11"));
      assert.doesNotMatch(local, /Sat|Sun/);
    }
  } finally { bot.cleanup(); }
  assert.equal(bot.jobs.length, 0);
});
