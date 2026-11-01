# AI Standup & Blocker Copilot

Discord check-ins with Gemini structured task, blocker, risk, and commitment extraction, plus a daily team digest.

## Setup

Use Node.js 20 or newer:

```sh
npm ci
cp .env.example .env
# Set DISCORD_TOKEN, GEMINI_API_KEY and STANDUP_CHANNEL_ID in .env
npm start
```

Enable **Message Content Intent** and **Server Members Intent** in the Discord developer portal (the latter supports existing DM questionnaires). Give the bot View Channel, Send Messages, Embed Links, Create Public Threads, and Send Messages in Threads permissions. If thread creation fails, channel commands still work.

## Standups

- At 9 AM Monday–Friday, the bot posts a prompt and creates a standup thread.
- Submit `!standup Finished tests; working on release; blocked on credentials; will ship Friday` in the configured channel, or send an update in today's bot-created thread.
- The bot replies with accomplishments, active tasks, blockers, risk, and commitments. The latest successful update per user replaces their previous submission in the digest.
- At 11 AM Monday–Friday, the bot publishes a digest when there are updates.

Schedules use `STANDUP_TIMEZONE` (default `America/Los_Angeles`), including daylight saving changes. Set `GEMINI_MODEL` to override `gemini-2.5-flash`. The process must remain running; missed jobs are not replayed. Standup intake is confined to the configured guild channel and today's thread.

Updates and Discord usernames are sent to Google's Gemini API for analysis. Storage is currently in memory: restarting loses updates and the active thread reference. Old threads are not ingested after restart; use the channel command until the next prompt. Days are isolated by local calendar date, and previous-day memory is pruned at the next prompt. Run one instance to avoid duplicate scheduled posts. AI analysis can be wrong; review blockers and deadlines before acting.

## Existing check-ins

For the original weekday 8 AM Los Angeles DM questionnaires, configure both `CHANNEL_ID` (guild membership source) and `RESPONSE_CHANNEL_ID` (collected answers). Set `CHECK_IN_CHANNEL_ID` for the original daily 9 AM attendance reminder. These settings are optional when standups are configured. Deployments without `STANDUP_CHANNEL_ID` continue using all three legacy settings without a Gemini key.

## Database foundation

Run `supabase/migrations/20261101000000_standup_copilot.sql` in the Supabase SQL editor or your migration workflow. It creates standup records, commitments, and guild subscription metadata. Row level security is enabled without client policies; use a trusted backend service role when adding storage.

This release does **not** write to Supabase or enforce paid tiers. Persistent commitment follow-up, subscription checks, Stripe integration, and authenticated guild policies require backend wiring. No Supabase credentials are needed for the current in-memory bot.

## Validation

```sh
npm test
```

Tests mock Gemini and Discord; they do not send messages or require credentials. A live smoke test requires a Discord token, Gemini key, and test channel.

