-- Run after the Sánchez Magallanes resolver deployment. Approximate plaza
-- reference, not an incident GPS point or a validated km 103.8 post.
begin;

update public.alerts as a
set latitude = 18.03070430,
    longitude = -93.81326158,
    location_confidence = 0.90,
    location_precision = 'toll_reference',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · Plaza de Cobro Sánchez Magallanes') || ' · caseta como referencia aproximada'
where a.location_status = 'unlocated'
  and a.latitude is null and a.longitude is null
  and a.road ~* '^C[aá]rdenas[[:space:]]*[-–—][[:space:]]*Coatzacoalcos$'
  and a.location_label ilike '%Plaza de Cobro Sánchez Magallanes%'
  and a.kilometer between 103 and 104
  and (a.state is null or lower(a.state) = 'tabasco')
  and a.event_at >= now() - interval '24 hours';

commit;
