import { createClient } from "@supabase/supabase-js";
import { validateAnalysis } from "./ai.js";

export function canUse(subscription, feature) {
  if (subscription?.active !== true || !["free", "pro", "enterprise"].includes(subscription.tier)) return false;
  return feature === "intake" || (feature === "digest" && ["pro", "enterprise"].includes(subscription.tier));
}

export class MemoryStore {
  constructor() { this.entries = new Map(); this.sessions = new Map(); }
  async subscription() { return { tier: "enterprise", active: true }; }
  async saveEntry(entry) {
    this.entries.set(JSON.stringify([entry.guildId, entry.channelId, entry.day, entry.userId]), structuredClone(entry));
  }
  async dailyEntries(guildId, channelId, day) {
    return [...this.entries.values()].filter(e => e.guildId === guildId && e.channelId === channelId && e.day === day);
  }
  async saveSession(session) { this.sessions.set(JSON.stringify([session.guildId, session.channelId, session.day]), session); }
  async session(guildId, channelId, day) { return this.sessions.get(JSON.stringify([guildId, channelId, day])); }
}

export class SupabaseStore {
  constructor(client) { this.client = client; }
  async result(query) {
    const { data, error } = await query;
    // Avoid logging database error details, which can contain private update data.
    if (error) throw new Error(`Standup database request failed (${error.code || "unknown"})`);
    return data;
  }
  async subscription(guildId) {
    const value = await this.result(this.client.from("guild_subscriptions").select("tier,active").eq("guild_id", guildId).maybeSingle());
    return value || { tier: "free", active: true };
  }
  async saveEntry(entry) {
    await this.result(this.client.from("standup_records").upsert({
      discord_user_id: entry.userId, guild_id: entry.guildId, channel_id: entry.channelId,
      standup_day: entry.day, user_tag: entry.user, raw_message: entry.raw,
      risk_level: entry.analysis.riskLevel, completed: entry.analysis.completed,
      in_progress: entry.analysis.inProgress, blockers: entry.analysis.blockers,
      commitments: entry.analysis.commitments, updated_at: new Date().toISOString(),
    }, { onConflict: "guild_id,channel_id,standup_day,discord_user_id" }));
  }
  async dailyEntries(guildId, channelId, day) {
    const entries = [];
    // Page explicitly so large guilds aren't truncated by the Data API row limit.
    for (let offset = 0; ; offset += 500) {
      const rows = await this.result(this.client.from("standup_records")
        .select("discord_user_id,user_tag,guild_id,raw_message,risk_level,completed,in_progress,blockers,commitments")
        .eq("guild_id", guildId).eq("channel_id", channelId).eq("standup_day", day)
        .order("discord_user_id").range(offset, offset + 499));
      for (const row of rows) entries.push({
        user: row.user_tag || row.discord_user_id, userId: row.discord_user_id,
        guildId: row.guild_id, raw: row.raw_message,
        analysis: validateAnalysis({ completed: row.completed, inProgress: row.in_progress,
          blockers: row.blockers, commitments: row.commitments, riskLevel: row.risk_level }),
      });
      if (rows.length < 500) break;
    }
    return entries;
  }
  async saveSession({ guildId, channelId, day, threadId }) {
    await this.result(this.client.from("standup_sessions").upsert({
      guild_id: guildId, channel_id: channelId, standup_day: day, thread_id: threadId,
    }, { onConflict: "guild_id,channel_id,standup_day" }));
  }
  async session(guildId, channelId, day) {
    const row = await this.result(this.client.from("standup_sessions").select("thread_id")
      .eq("guild_id", guildId).eq("channel_id", channelId).eq("standup_day", day).maybeSingle());
    return row ? { threadId: row.thread_id } : null;
  }
}

export function createStore(env = process.env) {
  const mode = env.STANDUP_STORAGE || "supabase";
  if (mode === "memory") return new MemoryStore();
  if (mode !== "supabase") throw new Error("STANDUP_STORAGE must be supabase or memory");
  const key = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!env.SUPABASE_URL || !key) throw new Error("Supabase storage requires SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY)");
  return new SupabaseStore(createClient(env.SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) }) },
  }));
}
