import { EmbedBuilder } from "discord.js";
import schedule from "node-schedule";
import { parseStandupResponse, generateDailyDigest } from "./ai.js";

export const clip = (text, max) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
export const dayKey = (date, timezone) => new Intl.DateTimeFormat("en-CA", {
  timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
}).format(date);
const colors = { LOW: 0x57F287, MEDIUM: 0xFEE75C, HIGH: 0xED4245 };

export class StandupCopilot {
  constructor(client, { channelId, timezone = "America/Los_Angeles", parse = parseStandupResponse, digest = generateDailyDigest, now = () => new Date() }) {
    this.client = client;
    this.channelId = channelId;
    this.timezone = timezone;
    dayKey(new Date(), timezone); // Fail fast for invalid timezone configuration.
    this.parse = parse;
    this.digest = digest;
    this.now = now;
    this.entries = new Map();
    this.threads = new Map();
    this.pending = new Set();
    this.jobs = [];
  }

  async channel() {
    const channel = await this.client.channels.fetch(this.channelId);
    if (!channel?.guildId || !channel.isTextBased() || typeof channel.send !== "function") {
      throw new Error("STANDUP_CHANNEL_ID must be a guild text channel");
    }
    return channel;
  }

  start() {
    for (const [hour, action] of [[9, () => this.prompt()], [11, () => this.publishDigest()]]) {
      const job = schedule.scheduleJob({ hour, minute: 0, dayOfWeek: [1, 2, 3, 4, 5], tz: this.timezone },
        () => action().catch(error => console.error("Standup schedule failed:", error.message)));
      if (!job) throw new Error("Could not schedule standup job");
      this.jobs.push(job);
    }
  }

  async prompt() {
    const day = dayKey(this.now(), this.timezone);
    for (const map of [this.entries, this.threads]) {
      for (const key of map.keys()) if (key !== day) map.delete(key);
    }
    const channel = await this.channel();
    const message = await channel.send("☀️ **Standup Time!** Share what you finished, what you’re working on, blockers, and any commitments or deadlines. Use `!standup your update` here, or reply in today’s thread. Updates are sent to Gemini for analysis.");
    try {
      const thread = await message.startThread({ name: `Standup ${day}`, autoArchiveDuration: 1440 });
      this.threads.set(day, thread.id);
    } catch (error) {
      console.error("Standup thread unavailable; use !standup in the channel:", error.message);
    }
  }

  async handleMessage(message) {
    if (message.author.bot || !message.guildId) return;
    const day = dayKey(this.now(), this.timezone);
    const inThread = message.channelId === this.threads.get(day);
    if (message.channelId !== this.channelId && !inThread) return;
    const command = /^!standup(?:\s|$)/.test(message.content);
    if (!command && !inThread) return;
    const raw = (command ? message.content.replace(/^!standup\s*/, "") : message.content).trim();
    const reply = content => message.reply({ ...content, allowedMentions: { parse: [], repliedUser: false } });
    if (!raw) return reply({ content: "Use `!standup` followed by your tasks and blockers." });
    if (raw.length > 12000) return reply({ content: "Please keep your update under 12,000 characters." });
    const key = `${message.guildId}:${message.author.id}`;
    if (this.pending.has(key)) return reply({ content: "Your previous update is still being analyzed." });
    this.pending.add(key);
    let analysis;
    try {
      analysis = await this.parse(message.author.username, raw);
      if (day !== dayKey(this.now(), this.timezone)) {
        return await reply({ content: "The standup day changed while analyzing your update. Please submit it again." });
      }
      if (!this.entries.has(day)) this.entries.set(day, new Map());
      // Latest update per person replaces earlier submissions for the daily digest.
      this.entries.get(day).set(key, { user: message.author.username, userId: message.author.id, guildId: message.guildId, raw, analysis });
    } catch (error) {
      console.error("Standup analysis failed:", error.message);
      return await reply({ content: "Could not analyze your standup. Please try again shortly." });
    } finally {
      this.pending.delete(key);
    }
    const lines = (items, fallback) => clip(items.join("\n") || fallback, 1024);
    const embed = new EmbedBuilder()
      .setAuthor({ name: clip(`${message.author.username}'s Update`, 256), iconURL: message.author.displayAvatarURL() })
      .setColor(colors[analysis.riskLevel])
      .addFields(
        { name: "✅ Done", value: lines(analysis.completed, "None reported"), inline: true },
        { name: "🔨 In Progress", value: lines(analysis.inProgress, "None reported"), inline: true },
        { name: "🚨 Blockers / Risk", value: clip(`[${analysis.riskLevel}] ${analysis.blockers.join(", ") || "None"}`, 1024) },
        { name: "📌 Commitments", value: lines(analysis.commitments.map(item => `${item.task}${item.targetTimeframe ? ` — ${item.targetTimeframe}` : ""}`), "None reported") },
      );
    await reply({ embeds: [embed] });
  }

  async publishDigest() {
    const day = dayKey(this.now(), this.timezone);
    const channel = await this.channel();
    const entries = [...(this.entries.get(day)?.values() || [])].filter(entry => entry.guildId === channel.guildId);
    if (!entries.length) return;
    const digest = await this.digest(entries);
    const embed = new EmbedBuilder().setTitle("📋 Daily Team Alignment Digest")
      .setDescription(clip(digest, 4096))
      .setColor(entries.some(entry => entry.analysis.riskLevel === "HIGH") ? colors.HIGH : colors.LOW)
      .setTimestamp();
    await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
  }

  cleanup() {
    this.jobs.forEach(job => job.cancel());
    this.jobs = [];
  }
}
