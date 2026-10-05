-- =====================================================================
-- Zero Vial · AUDITORÍA de seguridad en Supabase (solo lectura)
-- Ejecuta cada bloque en el SQL Editor y revisa el resultado.
-- Ejecutar DESPUÉS de 02-rls-hardening.sql y otra vez antes de abrir al
-- público: las filas de "resultado" del bloque 9 deben dar todas PASS.
-- Tablas conocidas por el código: alerts, ingest_queue, worker_status,
--   location_corrections, profiles, alert_preferences, push_subscriptions
-- =====================================================================

-- 1) ¿Qué tablas de public tienen RLS activo?  (rls_activo debe ser true en TODAS)
select c.relname as tabla, c.relrowsecurity as rls_activo, c.relforcerowsecurity as rls_forzado
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r','p')
order by c.relrowsecurity, c.relname;

-- 2) Políticas existentes. Busca: using (true) en tablas que NO deberían ser públicas,
--    o políticas de escritura (insert/update/delete/all) para anon.
select tablename, policyname, cmd, roles, qual as using_expr, with_check
from pg_policies where schemaname = 'public'
order by tablename, cmd, policyname;

-- 3) Privilegios de TABLA concedidos a anon / authenticated.
--    Esperado: alerts -> solo SELECT. ingest_queue -> nada. profiles -> solo SELECT (authenticated).
select table_name, grantee, string_agg(privilege_type, ', ' order by privilege_type) as privilegios
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon','authenticated')
group by table_name, grantee
order by table_name, grantee;

-- 4) ESCALADA DE PRIVILEGIOS: ¿puede un usuario modificar su propio rol?
--    Si aparece una fila con column_name = 'role' (UPDATE o INSERT), un usuario podría hacerse admin.
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and grantee in ('anon','authenticated') and privilege_type in ('INSERT','UPDATE')
order by column_name, grantee;

-- 4b) Grants por COLUMNA heredados: REVOKE sobre la tabla no siempre borra los permisos
--     antiguos dados columna por columna. No debe quedar nada fuera de display_name.
select table_name, column_name, grantee, privilege_type
from information_schema.column_privileges
where table_schema = 'public'
  and grantee in ('anon','authenticated')
  and privilege_type in ('SELECT','INSERT','UPDATE','REFERENCES')
order by table_name, column_name, grantee;

-- 5) Vistas: por defecto se ejecutan con los permisos de su DUEÑO y se saltan el RLS.
--    security_invoker=true es lo seguro (PostgreSQL 15+).
select c.relname as vista, coalesce(c.reloptions::text, '(sin opciones: salta RLS)') as opciones
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'v';

-- 6) Funciones SECURITY DEFINER ejecutables por anon (se saltan RLS: revisa cada una)
select p.proname as funcion, p.prosecdef as security_definer,
       has_function_privilege('anon', p.oid, 'execute') as anon_ejecuta
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prosecdef
order by 1;

-- 7) Privilegios por defecto: las tablas NUEVAS nacen abiertas para anon/authenticated
select defaclrole::regrole as creador, defaclobjtype as tipo, defaclacl as privilegios
from pg_default_acl;

-- 8) Restricciones de servidor activas sobre location_corrections (anti-abuso).
--    Deben existir corrections_coords_mx y corrections_text_len, y el trigger
--    corrections_before_insert debe estar habilitado.
select conname, convalidated, pg_get_constraintdef(oid) as definicion
from pg_constraint
where conrelid = 'public.location_corrections'::regclass
order by conname;

-- 9) PRUEBA REAL como visitante anónimo (ejecuta UNO a la vez; un error = bien protegido):
--    begin; set local role anon; select count(*) from public.ingest_queue; rollback;
--    begin; set local role anon; select * from public.worker_status limit 1; rollback;
--    begin; set local role anon; insert into public.alerts (title) values ('x'); rollback;   -- debe fallar
--    begin; set local role anon; select * from public.location_corrections limit 1; rollback; -- debe dar 0 filas o error
--    begin; set local role anon; update public.profiles set role = 'admin'; rollback;        -- debe fallar
--    begin; set local role anon; select * from public.push_subscriptions limit 1; rollback;   -- debe fallar

-- 10) Resumen. Todas las filas deben devolver PASS.
with target(table_name) as (values
  ('alerts'),('ingest_queue'),('worker_status'),('location_corrections'),
  ('profiles'),('alert_preferences'),('push_subscriptions')
)
select 'anon_write_access' as check_name,
  case when exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.grantee = 'anon'
      and g.privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')
      and g.table_name in (select table_name from target)
  ) or exists (
    select 1 from information_schema.column_privileges c
    where c.table_schema = 'public' and c.grantee = 'anon'
      and c.privilege_type in ('INSERT','UPDATE','REFERENCES')
      and c.table_name in (select table_name from target)
  ) then 'FAIL' else 'PASS' end as result
union all
select 'public_feed_write_access',
  case when exists (
    select 1 from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name in ('alerts','worker_status')
      and g.grantee in ('anon','authenticated') and g.privilege_type <> 'SELECT'
  ) or exists (
    select 1 from information_schema.column_privileges c
    where c.table_schema = 'public' and c.table_name in ('alerts','worker_status')
      and c.grantee in ('anon','authenticated')
      and c.privilege_type in ('INSERT','UPDATE','REFERENCES')
  ) then 'FAIL' else 'PASS' end
union all
select 'profile_sensitive_columns',
  case when exists (
    select 1 from information_schema.column_privileges c
    where c.table_schema = 'public' and c.table_name = 'profiles'
      and c.grantee in ('anon','authenticated')
      and c.privilege_type in ('INSERT','UPDATE','REFERENCES')
      and c.column_name <> 'display_name'
  ) then 'FAIL' else 'PASS' end
union all
select 'rls_enabled',
  case when exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in (select table_name from target)
      and not c.relrowsecurity
  ) then 'FAIL' else 'PASS' end
union all
select 'internal_queue_closed',
  case when exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'ingest_queue'
  ) then 'FAIL' else 'PASS' end
union all
select 'worker_status_main_only',
  case when exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'worker_status'
      and qual is not null and qual not ilike '%true%'
  ) then 'PASS' else 'FAIL' end;
