-- Zero Vial · aprendizaje a partir de correcciones aprobadas
-- Ejecutar DESPUÉS de supabase/corrections-review.sql.
--
-- Cuando un operador aprueba una corrección, el frontend también guarda aquí
-- una versión "generalizada": la frase/lugar (normalizado) + la coordenada
-- confirmada por una persona. El worker consulta esta tabla antes de
-- geocodificar una alerta nueva, así que una vez aprobada una referencia,
-- las alertas futuras que la mencionen la reutilizan automáticamente.

create table if not exists public.learned_locations (
  id uuid primary key default gen_random_uuid(),
  match_key text not null unique,
  label text not null,
  latitude double precision not null,
  longitude double precision not null,
  source_correction_id uuid references public.location_corrections(id) on delete set null,
  approved_by uuid references auth.users(id),
  uses integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.learned_locations is
  'Lugares cuya coordenada fue confirmada a mano al aprobar una corrección. match_key es el nombre normalizado (sin acentos, minúsculas) que el worker busca dentro del texto de alertas nuevas.';

alter table public.learned_locations enable row level security;
revoke all on table public.learned_locations from anon;

drop policy if exists "learned_locations_select_all" on public.learned_locations;
create policy "learned_locations_select_all"
on public.learned_locations for select to authenticated
using (true);

drop policy if exists "learned_locations_write_staff" on public.learned_locations;
create policy "learned_locations_write_staff"
on public.learned_locations for insert to authenticated
with check (
  exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin'))
);

drop policy if exists "learned_locations_update_staff" on public.learned_locations;
create policy "learned_locations_update_staff"
on public.learned_locations for update to authenticated
using (
  exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin'))
)
with check (
  exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin'))
);

grant select, insert, update on table public.learned_locations to authenticated;
