-- Zero Vial · esquema inicial para Supabase
-- Ejecutar una sola vez desde SQL Editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  plan text not null default 'free' check (plan in ('free','trial','pro','company')),
  trial_ends_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  external_id text unique,
  title text not null,
  detail text,
  category text not null check (category in ('road','security')),
  severity text not null default 'medium' check (severity in ('critical','high','medium','low')),
  state text,
  municipality text,
  road text,
  kilometer numeric,
  location_label text,
  latitude double precision,
  longitude double precision,
  location_confidence numeric check (location_confidence between 0 and 1),
  location_status text not null default 'automatic' check (location_status in ('automatic','approximate','corrected','verified')),
  source_name text,
  source_url text,
  event_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.location_corrections (
  id uuid primary key default gen_random_uuid(),
  alert_external_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  original_latitude double precision,
  original_longitude double precision,
  corrected_latitude double precision not null,
  corrected_longitude double precision not null,
  corrected_label text,
  reason text not null check (char_length(reason) between 5 and 500),
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.alert_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  categories text[] not null default array['road','security'],
  severities text[] not null default array['critical','high','medium'],
  states text[] not null default '{}',
  radius_km integer not null default 50 check (radius_km between 1 and 500),
  time_window_hours integer not null default 3 check (time_window_hours in (1,3,6,12,24)),
  blockages_only boolean not null default false,
  push_enabled boolean not null default false,
  quiet_start time,
  quiet_end time,
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  user_agent text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, plan, trial_ends_at)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', split_part(new.email,'@',1)), 'trial', now() + interval '7 days')
  on conflict (id) do nothing;
  insert into public.alert_preferences (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.alerts enable row level security;
alter table public.location_corrections enable row level security;
alter table public.alert_preferences enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "alerts readable by everyone" on public.alerts;
create policy "alerts readable by everyone" on public.alerts for select using (true);

drop policy if exists "users read own profile" on public.profiles;
create policy "users read own profile" on public.profiles for select using (auth.uid() = id);
drop policy if exists "users update own profile" on public.profiles;
create policy "users update own profile" on public.profiles for update using (auth.uid() = id) with check (auth.uid() = id);
revoke update on public.profiles from authenticated;
grant update (display_name) on public.profiles to authenticated;

drop policy if exists "users create corrections" on public.location_corrections;
create policy "users create corrections" on public.location_corrections for insert with check (auth.uid() = user_id);
drop policy if exists "users read own corrections" on public.location_corrections;
create policy "users read own corrections" on public.location_corrections for select using (auth.uid() = user_id);

drop policy if exists "users manage own preferences" on public.alert_preferences;
create policy "users manage own preferences" on public.alert_preferences for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
create policy "users manage own push subscriptions" on public.push_subscriptions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists alerts_event_at_idx on public.alerts(event_at desc);
create index if not exists alerts_state_idx on public.alerts(state);
create index if not exists corrections_alert_idx on public.location_corrections(alert_external_id, created_at desc);
