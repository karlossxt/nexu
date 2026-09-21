-- Zero Vial · migración de precisión geográfica
-- Ejecutar una vez en Supabase SQL Editor antes de desplegar el worker actualizado.

alter table public.alerts
  add column if not exists location_precision text;

comment on column public.alerts.location_precision is
  'Tipo de resolución geográfica: exact, toll_reference, kilometer_static, kilometer, intersection, reference, road, zone, municipality o state.';
