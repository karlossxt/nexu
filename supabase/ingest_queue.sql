-- Zero Vial · cola persistente de noticias
-- Ejecutar una vez en Supabase > SQL Editor antes de desplegar el worker.

begin;

create table if not exists public.ingest_queue (
  external_id text primary key,
  item jsonb not null,
  feed_url text,
  priority integer not null default 0,
  published_at timestamptz not null,
  status text not null default 'pending'
    check (status in ('pending','processing','retry','completed','failed')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  processing_started_at timestamptz,
  completed_at timestamptz,
  last_error text,
  enqueued_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ingest_queue_ready_idx
on public.ingest_queue (status, next_attempt_at, priority desc, published_at desc);

alter table public.ingest_queue enable row level security;
revoke all on table public.ingest_queue from anon, authenticated;

commit;

-- Verificación: debe devolver true.
select relrowsecurity as rls_enabled
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'ingest_queue';
