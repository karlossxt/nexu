-- Zero Vial · endurecimiento RLS para producción
-- Ejecutar en Supabase > SQL Editor con un usuario administrador.
-- Es idempotente: puede ejecutarse de nuevo sin duplicar políticas.

begin;

alter table public.alerts enable row level security;
alter table public.profiles enable row level security;
alter table public.alert_preferences enable row level security;
alter table public.worker_status enable row level security;
alter table public.location_corrections enable row level security;
alter table public.push_subscriptions enable row level security;

-- Primero se elimina cualquier permiso heredado. Las políticas RLS no sustituyen
-- los GRANT: ambos controles deben coincidir.
revoke all on table public.alerts from anon, authenticated;
revoke all on table public.profiles from anon, authenticated;
revoke all on table public.alert_preferences from anon, authenticated;
revoke all on table public.worker_status from anon, authenticated;
revoke all on table public.location_corrections from anon, authenticated;
revoke all on table public.push_subscriptions from anon, authenticated;

-- REVOKE sobre la tabla no siempre elimina concesiones antiguas hechas sobre
-- columnas individuales. Se limpian SELECT/INSERT/UPDATE/REFERENCES columna por
-- columna antes de devolver únicamente los permisos mínimos definidos abajo.
do $$
declare
  target_table text;
  target_columns text;
begin
  foreach target_table in array array[
    'alerts','profiles','alert_preferences','worker_status',
    'location_corrections','push_subscriptions'
  ] loop
    select string_agg(format('%I', column_name), ', ' order by ordinal_position)
      into target_columns
    from information_schema.columns
    where table_schema = 'public' and table_name = target_table;

    if target_columns is not null then
      execute format('revoke select (%s) on table public.%I from anon, authenticated', target_columns, target_table);
      execute format('revoke insert (%s) on table public.%I from anon, authenticated', target_columns, target_table);
      execute format('revoke update (%s) on table public.%I from anon, authenticated', target_columns, target_table);
      execute format('revoke references (%s) on table public.%I from anon, authenticated', target_columns, target_table);
    end if;
  end loop;
end $$;

-- Feed público: el navegador sólo lee; Render escribe con service_role.
drop policy if exists "alerts readable by everyone" on public.alerts;
drop policy if exists "alerts_public_read" on public.alerts;
create policy "alerts_public_read"
on public.alerts for select
to anon, authenticated
using (true);
grant select on table public.alerts to anon, authenticated;

-- Salud del worker: sólo lectura pública; service_role actualiza.
drop policy if exists "worker status readable by everyone" on public.worker_status;
drop policy if exists "worker_status_public_read" on public.worker_status;
create policy "worker_status_public_read"
on public.worker_status for select
to anon, authenticated
using (true);
grant select on table public.worker_status to anon, authenticated;

-- Perfil: cada cuenta ve su registro. Desde el cliente sólo puede cambiar nombre.
drop policy if exists "users read own profile" on public.profiles;
drop policy if exists "users update own profile" on public.profiles;
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_select_own"
on public.profiles for select
to authenticated
using ((select auth.uid()) = id);
create policy "profiles_update_own"
on public.profiles for update
to authenticated
using ((select auth.uid()) = id)
with check ((select auth.uid()) = id);
grant select on table public.profiles to authenticated;
grant update (display_name) on table public.profiles to authenticated;

-- Preferencias: políticas separadas para que cada operación sea auditable.
drop policy if exists "users manage own preferences" on public.alert_preferences;
drop policy if exists "preferences_select_own" on public.alert_preferences;
drop policy if exists "preferences_insert_own" on public.alert_preferences;
drop policy if exists "preferences_update_own" on public.alert_preferences;
drop policy if exists "preferences_delete_own" on public.alert_preferences;
create policy "preferences_select_own"
on public.alert_preferences for select to authenticated
using ((select auth.uid()) = user_id);
create policy "preferences_insert_own"
on public.alert_preferences for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "preferences_update_own"
on public.alert_preferences for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "preferences_delete_own"
on public.alert_preferences for delete to authenticated
using ((select auth.uid()) = user_id);
grant select, insert, update, delete on table public.alert_preferences to authenticated;

-- Correcciones de ubicación: el usuario crea y consulta únicamente las propias.
drop policy if exists "users create corrections" on public.location_corrections;
drop policy if exists "users read own corrections" on public.location_corrections;
drop policy if exists "corrections_insert_own" on public.location_corrections;
drop policy if exists "corrections_select_own" on public.location_corrections;
create policy "corrections_insert_own"
on public.location_corrections for insert to authenticated
with check ((select auth.uid()) = user_id and status = 'pending' and reviewed_by is null and reviewed_at is null);
create policy "corrections_select_own"
on public.location_corrections for select to authenticated
using ((select auth.uid()) = user_id);
grant select, insert on table public.location_corrections to authenticated;

-- Suscripciones push: cada cuenta administra sólo sus propios endpoints.
drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
drop policy if exists "push_select_own" on public.push_subscriptions;
drop policy if exists "push_insert_own" on public.push_subscriptions;
drop policy if exists "push_update_own" on public.push_subscriptions;
drop policy if exists "push_delete_own" on public.push_subscriptions;
create policy "push_select_own"
on public.push_subscriptions for select to authenticated
using ((select auth.uid()) = user_id);
create policy "push_insert_own"
on public.push_subscriptions for insert to authenticated
with check ((select auth.uid()) = user_id);
create policy "push_update_own"
on public.push_subscriptions for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
create policy "push_delete_own"
on public.push_subscriptions for delete to authenticated
using ((select auth.uid()) = user_id);
grant select, insert, update, delete on table public.push_subscriptions to authenticated;

-- Evita que futuras tablas creadas por postgres nazcan abiertas por accidente.
alter default privileges for role postgres in schema public
revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
revoke all on sequences from anon, authenticated;

commit;
