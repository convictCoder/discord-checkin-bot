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

