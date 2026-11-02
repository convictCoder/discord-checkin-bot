# Run the bot on Render

The repository includes `render.yaml` for one always-on background worker. Render background workers require a paid plan; review the current Starter price in Render before creating the service. No service is created by committing this file. Automatic deployments are disabled.

## Create the credentials

1. Open the [Discord developer portal](https://discord.com/developers/applications). Select your existing bot application, or create one. In **Bot**, create or reset the bot token and store it in a password manager. Resetting an existing token invalidates it for any currently running bot, so reuse your existing securely stored token when available. Enable **Message Content Intent** and **Server Members Intent**.
2. In **OAuth2 → URL Generator**, choose `bot` and the permissions View Channels, Send Messages, Embed Links, Create Public Threads, and Send Messages in Threads. Open the generated URL to install the bot in your server. The `applications.commands` scope is not needed for the `!standup` prefix command.
3. Enable Discord Developer Mode in user settings. Right-click the standup channel and choose **Copy Channel ID**. Store this as `STANDUP_CHANNEL_ID`.
4. Create a Gemini API key in [Google AI Studio](https://aistudio.google.com/apikey). Store it as `GEMINI_API_KEY`. Review Google's API quotas and billing for the selected model.
5. Open the selected [Supabase project](https://supabase.com/dashboard/project/evxsybqpsmtmlkppffrb). Confirm it is active. Under **Settings → API Keys**, obtain a server-only secret key. Use it as `SUPABASE_SECRET_KEY`; a legacy `service_role` key is also supported via `SUPABASE_SERVICE_ROLE_KEY`. A publishable/anon key cannot access these tables.

Never paste tokens into Discord, issues, pull requests, or chat. Enter them directly in Render's secret fields.

## Database and service

1. Ensure `supabase/migrations/20261102064033_standup_copilot.sql` has been applied to the selected project. If it was already applied during setup, do not apply it again through a migration manager; inspect the migration history first. The SQL itself is repeatable.
2. After the pull request is merged, sign in to [Render](https://dashboard.render.com/) and choose **New → Blueprint**. Connect `convictCoder/discord-checkin-bot`, choose the merged branch, and review the `render.yaml` configuration.
3. Enter `DISCORD_TOKEN`, `GEMINI_API_KEY`, `STANDUP_CHANNEL_ID`, and `SUPABASE_SECRET_KEY` when prompted. Confirm the Supabase URL and choose your preferred `STANDUP_TIMEZONE`.
4. Review the paid worker plan, then create the Blueprint. Keep exactly one worker instance running. There is no public web endpoint to configure.
5. Check the worker logs for successful Discord login and no storage-restore errors. A storage failure closes the Discord client and exits with failure. Render can then restart the process after you correct the configuration.

## Smoke test

Post `!standup Finished tests; building release; blocked on API access; will ship Friday` in the configured channel. Expect an analysis embed including the commitment. Confirm a row exists in `standup_records`, then restart the worker and confirm that row remains. Updates overwrite the same user's row only within the same guild, channel, and local date.

The default tier is Free, which enables standup parsing but not team digests. To test digests, provision your guild as Pro using the SQL in the README. No payment is collected by this operation. Wait for the next weekday 11 AM digest; standup prompts run at weekday 9 AM. Existing today's threads are restored after a restart. If the bot has never posted a prompt, use channel commands until its first scheduled prompt.

Disable the subscription row and submit again to verify that AI is blocked. Re-enable it when finished. Do this in a test guild before inviting a wider team.

Live verification needs your credentials and server access. Unit tests use mocks and cannot verify Discord permissions, Google quota, or the worker's network connection.

## Setup status

The selected Supabase project was restored and migration `20261102064033_standup_copilot` applied on November 2, 2026. A transactional backend-role smoke test verified record/session writes and subscription reads, then rolled back all temporary data. Supabase's security advisor returned informational [RLS enabled without policies](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) notices; this is intentional for backend-only tables with client-role privileges revoked.

The Render service has not been created. Discord/Gemini credentials still need to be supplied directly in the hosting dashboard before deployment and live testing.
