-- Zero Vial · learned_locations v2 + permisos de revisión + cierre de tablas de push
-- Ejecutar en el SQL Editor de Supabase DESPUÉS de schema.sql y rls_hardening.sql.
-- Es idempotente: se puede repetir sin efectos secundarios.
-- Reemplaza a supabase/learned-locations-v2.sql (incluye todo lo que tenía).

-- 1) Extensión y columnas que usa el worker ---------------------------------
create extension if not exists pg_trgm;

alter table public.alerts               add column if not exists crime_type text;
alter table public.location_corrections add column if not exists applied_at timestamptz;

alter table public.learned_locations add column if not exists state     text;
alter table public.learned_locations add column if not exists road_norm text;
alter table public.learned_locations add column if not exists kilometer numeric;
alter table public.learned_locations add column if not exists aliases   text[] not null default '{}';
alter table public.learned_locations add column if not exists precision text;

create index if not exists learned_locations_state_idx on public.learned_locations (state);
do $$ begin
  create index if not exists learned_locations_label_trgm_idx on public.learned_locations using gin (label gin_trgm_ops);
exception when others then
  raise notice 'No se creó el índice trigram (%). No afecta el funcionamiento.', sqlerrm;
end $$;

-- 2) learned_locations: lectura para cuentas con sesión, administración solo staff
alter table public.learned_locations enable row level security;
revoke all on table public.learned_locations from anon;

drop policy if exists "learned_locations_select_all"   on public.learned_locations;
drop policy if exists "learned_locations_write_staff"  on public.learned_locations;
drop policy if exists "learned_locations_update_staff" on public.learned_locations;
drop policy if exists "learned_locations_delete_staff" on public.learned_locations;

create policy "learned_locations_select_all"
on public.learned_locations for select to authenticated
using (true);

create policy "learned_locations_write_staff"
on public.learned_locations for insert to authenticated
with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')));

create policy "learned_locations_update_staff"
on public.learned_locations for update to authenticated
using      (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')))
with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')));

create policy "learned_locations_delete_staff"
on public.learned_locations for delete to authenticated
using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')));

grant select, insert, update, delete on table public.learned_locations to authenticated;

-- 3) location_corrections: operadores y admins revisan; el resto sigue viendo solo lo suyo
drop policy if exists "corrections_select_staff" on public.location_corrections;
drop policy if exists "corrections_update_staff" on public.location_corrections;

create policy "corrections_select_staff"
on public.location_corrections for select to authenticated
using (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')));

create policy "corrections_update_staff"
on public.location_corrections for update to authenticated
using      (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin')))
with check (exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role in ('operator','admin'))
            and status in ('approved','rejected') and reviewed_by = (select auth.uid()));

-- SELECT/INSERT ya los concede rls_hardening.sql; aquí solo las columnas que puede cambiar una revisión.
grant select, insert on table public.location_corrections to authenticated;
revoke update on table public.location_corrections from authenticated;
grant update (status, reviewed_by, reviewed_at) on table public.location_corrections to authenticated;

-- 4) Tablas de push: contienen la llave privada VAPID y los endpoints de los dispositivos.
--    Solo el worker (service_role) debe leerlas. El navegador usa las funciones
--    push_subscribe / push_unsubscribe (security definer), que no necesitan estos permisos.
--    Después de correrlo, prueba activar y desactivar notificaciones desde la app.
do $$
declare t text;
begin
  foreach t in array array['push_config','webpush_devices','push_subscriptions'] loop
    if to_regclass('public.' || t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('revoke all on table public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- 5) Auditoría (ejecútalas por separado y revisa el resultado) ---------------------
-- RLS activo (rowsecurity debe ser true en las cinco):
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public'
--     and tablename in ('push_config','webpush_devices','push_subscriptions','ingest_queue','learned_locations','location_corrections');
--
-- Permisos directos. Para push_config, webpush_devices e ingest_queue NO debe aparecer anon ni authenticated:
--   select table_name, grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public'
--     and table_name in ('push_config','webpush_devices','push_subscriptions','ingest_queue','learned_locations','location_corrections')
--     and grantee in ('anon','authenticated')
--   order by table_name, grantee, privilege_type;
--
-- Políticas vigentes en las dos tablas de aprendizaje:
--   select tablename, policyname, cmd from pg_policies
--   where schemaname = 'public' and tablename in ('learned_locations','location_corrections')
--   order by tablename, policyname;
