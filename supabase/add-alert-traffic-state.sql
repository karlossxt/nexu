-- Zero Vial · separación entre tipo de evento y estado vial actual
-- Ejecutar una vez en Supabase SQL Editor antes de desplegar el worker actualizado.

alter table public.alerts
  add column if not exists event_type text;

alter table public.alerts
  add column if not exists traffic_status text;

comment on column public.alerts.event_type is
  'Tipo de evento: traffic_update, crash, closure, blockage, protest, road_hazard, security_incident, emergency u other.';

comment on column public.alerts.traffic_status is
  'Estado vial actual: flowing, slow, partial, blocked, closed, restored o unknown.';
