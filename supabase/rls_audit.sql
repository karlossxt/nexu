-- Zero Vial · auditoría no destructiva de RLS y privilegios
-- Ejecutar después de rls_hardening.sql. El primer resultado debe mostrar
-- rowsecurity=true en las seis tablas y el segundo debe mostrar los permisos
-- mínimos descritos en la columna expected_access.

select
  n.nspname as schema_name,
  c.relname as table_name,
  c.relrowsecurity as rowsecurity,
  c.relforcerowsecurity as force_rowsecurity
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in (
    'alerts','profiles','alert_preferences','worker_status',
    'location_corrections','push_subscriptions'
  )
order by c.relname;

select
  table_name,
  grantee,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges,
  case
    when table_name in ('alerts','worker_status') then 'anon/authenticated: SELECT'
    when table_name = 'profiles' then 'authenticated: SELECT; UPDATE sólo display_name'
    when table_name = 'alert_preferences' then 'authenticated: SELECT/INSERT/UPDATE/DELETE con RLS propia'
    when table_name = 'location_corrections' then 'authenticated: SELECT/INSERT con RLS propia'
    when table_name = 'push_subscriptions' then 'authenticated: SELECT/INSERT/UPDATE/DELETE con RLS propia'
  end as expected_access
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'alerts','profiles','alert_preferences','worker_status',
    'location_corrections','push_subscriptions'
  )
  and grantee in ('anon','authenticated')
group by table_name, grantee
order by table_name, grantee;

select
  schemaname,
  tablename,
  policyname,
  roles,
  cmd,
  qual,
  with_check
from pg_policies
where schemaname = 'public'
  and tablename in (
    'alerts','profiles','alert_preferences','worker_status',
    'location_corrections','push_subscriptions'
  )
order by tablename, cmd, policyname;

-- Confirma que role y plan no son editables desde el cliente autenticado.
select
  grantee,
  table_name,
  column_name,
  privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and grantee = 'authenticated'
order by column_name, privilege_type;
