-- Zero Vial · ubicación aproximada + mapa de calor de seguridad
-- Ejecutar una vez en Supabase SQL Editor. Es idempotente y no requiere cambios
-- de estructura: `location_precision` es texto libre y `location_status` ya
-- admite 'approximate'. Solo documenta los nuevos valores y agrega un índice
-- para las consultas de agregación (categoría + fecha) que usa el frontend.

comment on column public.alerts.location_precision is
  'Tipo de resolución geográfica: exact, toll_reference, kilometer_static, kilometer, '
  'intersection, reference, road, zone, municipality, state y los niveles aproximados '
  'road_approximate, municipality_approximate y area_security (seguridad agregada por '
  'municipio; sin pin individual, alimenta el mapa de calor).';

create index if not exists alerts_category_event_at_idx
  on public.alerts (category, event_at desc);

create index if not exists alerts_state_municipality_idx
  on public.alerts (state, municipality);
