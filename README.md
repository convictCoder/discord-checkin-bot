# AI Standup & Blocker Copilot

Discord check-ins with Gemini structured task, blocker, risk, and commitment extraction, plus a daily team digest.

## Setup

Use Node.js 22 or newer:

```sh
npm ci
cp .env.example .env
# Set Discord, Gemini, and Supabase credentials in .env
npm start
```

Enable **Message Content Intent** and **Server Members Intent** in the Discord developer portal (the latter supports existing DM questionnaires). Give the bot View Channel, Send Messages, Embed Links, Create Public Threads, and Send Messages in Threads permissions. If thread creation fails, channel commands still work.

## Standups

- At 9 AM Monday–Friday, the bot posts a prompt and creates a standup thread.
- Submit `!standup Finished tests; working on release; blocked on credentials; will ship Friday` in the configured channel, or send an update in today's bot-created thread.
- The bot replies with accomplishments, active tasks, blockers, risk, and commitments. The latest successful update per user replaces their previous submission in the digest.
- At 11 AM Monday–Friday, the bot publishes a digest when there are updates.

Schedules use `STANDUP_TIMEZONE` (default `America/Los_Angeles`), including daylight saving changes. Set `GEMINI_MODEL` to override `gemini-2.5-flash`. The process must remain running; missed jobs are not replayed. Standup intake is confined to the configured guild channel and today's thread.

Updates and Discord usernames are sent to Google's Gemini API for analysis. Supabase stores each user's latest update per guild/channel/local day, including commitments and blockers; older days remain available in the database. Restarts reload digest inputs and today's thread reference. Database failures prevent successful acknowledgment or AI processing when subscription status cannot be checked. Run one bot instance to avoid duplicate scheduled posts. AI analysis can be wrong; review blockers and deadlines before acting.

## Storage and subscriptions

Persistence is the default. Configure `SUPABASE_URL` and server-only `SUPABASE_SECRET_KEY` (or legacy `SUPABASE_SERVICE_ROLE_KEY`). Never share these keys in Discord or commit them. Apply the migration before starting the bot. The selected project is `supabase-fuchsia-garden` (`evxsybqpsmtmlkppffrb`). Startup validates storage access and restores the current thread.

The bot reads `guild_subscriptions` on every intake and digest. A missing row means active Free. Free allows parsed standup updates; Pro and Enterprise additionally allow AI digests. An inactive row, an unrecognized tier, or a database error blocks AI features. Prompt posting is disabled for inactive subscriptions. Legacy questionnaires and attendance reminders are independent of these AI tier rules.

An administrator can provision tiers in the Supabase SQL editor:

```sql
insert into public.guild_subscriptions (guild_id, tier, active)
values ('YOUR_DISCORD_GUILD_ID', 'pro', true)
on conflict (guild_id) do update
set tier = excluded.tier, active = excluded.active, updated_at = now();
```

Tier changes are manual; Stripe checkout and webhook synchronization are not implemented. This does not charge customers. Human follow-up on commitments is supported through stored history and daily digests; automatic overdue reminders are not included.

For local demos only, set `STANDUP_STORAGE=memory`. This explicitly bypasses subscription checks and loses updates/thread references on restart. Do not use it for a paid deployment. Scheduled jobs require an always-on Node process with outbound HTTPS and Discord Gateway WebSocket access; serverless request handlers cannot host this bot.

## Existing check-ins

For the original weekday 8 AM Los Angeles DM questionnaires, configure both `CHANNEL_ID` (guild membership source) and `RESPONSE_CHANNEL_ID` (collected answers). Set `CHECK_IN_CHANNEL_ID` for the original daily 9 AM attendance reminder. These settings are optional when standups are configured. Deployments without `STANDUP_CHANNEL_ID` continue using all three legacy settings without a Gemini key.

## Database migration

Apply `supabase/migrations/20261101000000_standup_copilot.sql` in the Supabase SQL editor or migration workflow. It preserves the requested records and subscriptions tables and adds daily-user uniqueness, channel/day/user metadata, and thread sessions. Existing legacy records remain intact; their unknown local-day/channel values stay null and are excluded from new daily digests.

RLS is enabled on all bot tables, client roles have no access, and only the backend service role receives the minimum read/write grants needed by the bot. Provision subscription rows through a trusted administrative connection.

## Validation

```sh
npm test
```

Tests mock Gemini and Discord; they do not send messages or require credentials. A live smoke test requires a Discord token, Gemini key, and test channel.

