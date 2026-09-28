-- Run only after worker/frontend deployment. RNC 2025 posts 103/106 bound
-- these two reviewed estimates on the tolled Guadalajara–Colima corridor.
begin;

with estimates(km,lat,lon) as (
  values
    (104, 19.559756961439334, -103.44035251441161),
    (105, 19.551591567696082, -103.43525405303387)
)
update public.alerts as a
set latitude = estimates.lat,
    longitude = estimates.lon,
    location_confidence = 0.70,
    location_precision = 'kilometer_rnc_estimated',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · km ' || a.kilometer) || ' · km estimado entre postes RNC'
from estimates
where a.location_status = 'unlocated'
  and a.latitude is null and a.longitude is null
  and a.kilometer = estimates.km
  and a.road ilike '%Guadalajara%Colima%'
  and (a.state is null or lower(a.state) = 'jalisco')
  and a.event_at >= now() - interval '24 hours';

commit;
