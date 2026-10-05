-- =====================================================================
-- Zero Vial · ENDURECIMIENTO de RLS (Supabase / PostgreSQL)
--
-- Ejecutar DESPUÉS de schema.sql y ANTES de 01-rls-audit.sql.
--
-- ⚠ Pruébalo primero en una rama de Supabase o en un proyecto de staging.
--   Las secciones van dentro de `do $$ … if to_regclass(...) is not null`,
--   así que una tabla que todavía no existe simplemente se omite.
-- • Es idempotente: se puede repetir. Cada sección reemplaza sus políticas.
-- • service_role (tu worker) IGNORA el RLS: no se ve afectado.
-- • Qué queda asumido (es lo que lee el código del navegador):
--     alerts              -> el público solo LEE
--     worker_status       -> el público lee la fila id='main' y SOLO las 7 columnas que usa el mapa
--     ingest_queue        -> solo el worker (nadie desde el navegador)
--     location_corrections-> usuarios con sesión INSERTAN las suyas y leen las suyas
--     profiles            -> cada usuario lee SU fila; NADIE cambia su rol desde el cliente
--     alert_preferences   -> cada usuario lee/escribe SOLO las suyas
--     push_subscriptions  -> cada usuario administra SOLO sus endpoints
-- =====================================================================

begin;

-- Las políticas RLS no sustituyen a los GRANT: ambos controles deben coincidir.
-- Primero se elimina cualquier permiso heredado de tabla…
revoke all on table public.alerts              from anon, authenticated;
revoke all on table public.profiles            from anon, authenticated;
revoke all on table public.alert_preferences   from anon, authenticated;
revoke all on table public.worker_status       from anon, authenticated;
revoke all on table public.location_corrections from anon, authenticated;
revoke all on table public.push_subscriptions  from anon, authenticated;
revoke all on table public.ingest_queue        from anon, authenticated;

-- …y también los permisos antiguos concedidos COLUMNA por COLUMNA, que un
-- `revoke` sobre la tabla no siempre elimina.
do $$
declare
  target_table text;
  target_columns text;
begin
  foreach target_table in array array[
    'alerts','profiles','alert_preferences','worker_status',
    'location_corrections','push_subscriptions','ingest_queue'
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

-- ---------- alerts: lectura pública, escritura solo service_role ----------
do $$
begin
  if to_regclass('public.alerts') is not null then
    alter table public.alerts enable row level security;
    drop policy if exists "alerts readable by everyone" on public.alerts;
    drop policy if exists "alerts_public_read" on public.alerts;
    grant select on public.alerts to anon, authenticated;
    create policy alerts_public_read on public.alerts for select to anon, authenticated using (true);
  end if;
end $$;

-- ---------- ingest_queue: cola interna, solo el worker ----------
do $$
declare pol record;
begin
  if to_regclass('public.ingest_queue') is not null then
    alter table public.ingest_queue enable row level security;
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'ingest_queue' loop
      execute format('drop policy %I on public.ingest_queue', pol.policyname);
    end loop;
    -- sin políticas y sin grants: anon/authenticated no ven ni una fila
  end if;
end $$;

-- ---------- worker_status: lectura pública SOLO de la fila 'main' y de las columnas que usa el mapa ----------
-- El frontend pide exactamente: status, last_success_at, last_started_at,
-- last_error, last_stats, updated_at, filtrando id='main'.
do $$
begin
  if to_regclass('public.worker_status') is not null then
    alter table public.worker_status enable row level security;
    drop policy if exists "worker status readable by everyone" on public.worker_status;
    drop policy if exists "worker_status_public_read" on public.worker_status;
    grant select (id, status, last_success_at, last_started_at, last_error, last_stats, updated_at)
      on public.worker_status to anon, authenticated;
    create policy worker_status_public_read on public.worker_status for select to anon, authenticated using (id = 'main');
  end if;
end $$;

-- ---------- location_corrections: cada usuario inserta/lee las suyas ----------
do $$
begin
  if to_regclass('public.location_corrections') is not null then
    alter table public.location_corrections enable row level security;
    drop policy if exists "users create corrections" on public.location_corrections;
    drop policy if exists "users read own corrections" on public.location_corrections;
    drop policy if exists "corrections_insert_own" on public.location_corrections;
    drop policy if exists "corrections_select_own" on public.location_corrections;
    grant select, insert on public.location_corrections to authenticated;

    create policy corrections_insert_own on public.location_corrections for insert to authenticated
      with check (user_id = auth.uid()
                  and status = 'pending'
                  and reviewed_by is null and reviewed_at is null);   -- nadie puede auto-aprobarse

    create policy corrections_select_own on public.location_corrections for select to authenticated
      using (user_id = auth.uid());

    -- Validación en el SERVIDOR (las del navegador se pueden saltar).
    -- NOT VALID: no revalida las filas que ya existan.
    if not exists (select 1 from pg_constraint where conname = 'corrections_coords_mx') then
      alter table public.location_corrections add constraint corrections_coords_mx
        check (corrected_latitude between 14.3 and 32.9 and corrected_longitude between -118.6 and -86.5) not valid;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'corrections_text_len') then
      alter table public.location_corrections add constraint corrections_text_len
        check (char_length(reason) between 5 and 500 and char_length(corrected_label) between 5 and 200) not valid;
    end if;
  end if;
end $$;

-- Antiabuso: la hora la pone el servidor y como mucho 30 correcciones por usuario al día.
create or replace function public.corrections_before_insert() returns trigger
language plpgsql as $f$
begin
  new.created_at := now();
  if (select count(*) from public.location_corrections
       where user_id = new.user_id and created_at > now() - interval '1 day') >= 30 then
    raise exception 'límite diario de correcciones alcanzado';
  end if;
  return new;
end $f$;

do $$
begin
  if to_regclass('public.location_corrections') is not null then
    drop trigger if exists corrections_before_insert on public.location_corrections;
    create trigger corrections_before_insert before insert on public.location_corrections
      for each row execute function public.corrections_before_insert();
  end if;
end $$;

-- ---------- profiles: cada usuario lee SU fila; NADIE cambia su rol desde el cliente ----------
-- El frontend solo hace `select role`. El nombre se edita desde el panel, no desde el navegador.
do $$
begin
  if to_regclass('public.profiles') is not null then
    alter table public.profiles enable row level security;
    drop policy if exists "users read own profile" on public.profiles;
    drop policy if exists "users update own profile" on public.profiles;
    drop policy if exists "profiles_select_own" on public.profiles;
    drop policy if exists "profiles_update_own" on public.profiles;
    grant select on public.profiles to authenticated;
    create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
    -- Sin INSERT/UPDATE para authenticated: los roles se asignan desde el panel de Supabase
    -- o con service_role. Si algún día el usuario puede editar su nombre, concede SOLO eso:
    --   grant update (display_name) on public.profiles to authenticated;
    --   create policy profiles_update_own on public.profiles for update to authenticated
    --     using (id = auth.uid()) with check (id = auth.uid());
  end if;
end $$;

-- ---------- alert_preferences: solo las propias ----------
-- El frontend hace select y upsert(user_id); no borra, así que DELETE no se concede.
do $$
begin
  if to_regclass('public.alert_preferences') is not null then
    alter table public.alert_preferences enable row level security;
    drop policy if exists "users manage own preferences" on public.alert_preferences;
    drop policy if exists "preferences_select_own" on public.alert_preferences;
    drop policy if exists "preferences_insert_own" on public.alert_preferences;
    drop policy if exists "preferences_update_own" on public.alert_preferences;
    drop policy if exists "preferences_delete_own" on public.alert_preferences;
    grant select, insert, update on public.alert_preferences to authenticated;
    create policy prefs_select_own on public.alert_preferences for select to authenticated using (user_id = auth.uid());
    create policy prefs_insert_own on public.alert_preferences for insert to authenticated with check (user_id = auth.uid());
    create policy prefs_update_own on public.alert_preferences for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
  end if;
end $$;

-- ---------- push_subscriptions: cada cuenta administra solo sus endpoints ----------
do $$
begin
  if to_regclass('public.push_subscriptions') is not null then
    alter table public.push_subscriptions enable row level security;
    drop policy if exists "users manage own push subscriptions" on public.push_subscriptions;
    drop policy if exists "push_select_own" on public.push_subscriptions;
    drop policy if exists "push_insert_own" on public.push_subscriptions;
    drop policy if exists "push_update_own" on public.push_subscriptions;
    drop policy if exists "push_delete_own" on public.push_subscriptions;
    grant select, insert, update, delete on public.push_subscriptions to authenticated;
    create policy push_select_own on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
    create policy push_insert_own on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
    create policy push_update_own on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
    create policy push_delete_own on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
  end if;
end $$;

-- Evita que las tablas FUTURAS creadas por postgres nazcan abiertas por accidente.
-- Verifícalo en 01-rls-audit.sql bloque 7: debe listar este par de Privilegios.
do $$
begin
  if exists (select 1 from pg_roles where rolname = current_user) then
    begin
      execute 'alter default privileges for role ' || current_user || ' in schema public revoke all on tables from anon, authenticated';
      execute 'alter default privileges for role ' || current_user || ' in schema public revoke all on sequences from anon, authenticated';
    exception when others then
      raise notice 'No se pudieron ajustar los privileges por defecto: %', sqlerrm;
    end;
  end if;
end $$;

-- ---------- Verificación: vuelve a correr 01-rls-audit.sql, el bloque 10 debe dar todo PASS ----------

commit;
