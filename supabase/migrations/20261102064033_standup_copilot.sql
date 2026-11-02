create table if not exists public.standup_records (
  id uuid primary key default gen_random_uuid(),
  discord_user_id text not null,
  guild_id text not null,
  raw_message text not null,
  risk_level text check (risk_level in ('LOW', 'MEDIUM', 'HIGH')),
  completed jsonb default '[]'::jsonb,
  in_progress jsonb default '[]'::jsonb,
  blockers jsonb default '[]'::jsonb,
  commitments jsonb default '[]'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create index if not exists standup_records_guild_created_at_idx
  on public.standup_records (guild_id, created_at);

create table if not exists public.guild_subscriptions (
  guild_id text primary key,
  tier text check (tier in ('free', 'pro', 'enterprise')) default 'free',
  stripe_customer_id text,
  active boolean default true,
  updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Access via a trusted service-role backend until guild policies are implemented.
alter table public.standup_records enable row level security;
alter table public.guild_subscriptions enable row level security;

-- Nullable additions retain any legacy records without guessing their local day.
alter table public.standup_records
  add column if not exists channel_id text,
  add column if not exists standup_day date,
  add column if not exists user_tag text,
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists standup_records_daily_user_idx
  on public.standup_records (guild_id, channel_id, standup_day, discord_user_id);

create table if not exists public.standup_sessions (
  guild_id text not null,
  channel_id text not null,
  standup_day date not null,
  thread_id text not null,
  primary key (guild_id, channel_id, standup_day)
);
alter table public.standup_sessions enable row level security;

-- Explicit grants support projects where new tables aren't exposed by default.
grant usage on schema public to service_role;
grant select, insert, update on public.standup_records to service_role;
grant select on public.guild_subscriptions to service_role;
grant select, insert, update on public.standup_sessions to service_role;
revoke all on public.standup_records, public.guild_subscriptions, public.standup_sessions from anon, authenticated;

