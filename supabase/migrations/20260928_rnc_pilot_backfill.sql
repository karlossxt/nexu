-- Run only after the RNC pilot worker/frontend commit is deployed.
-- Upgrades still-active, unlocated alerts with exact reviewed road+km references.
-- The reference post is approximate; it is not the accident's GPS position.
begin;

update public.alerts
set latitude = 19.46473314598444,
    longitude = -103.46481122763824,
    location_confidence = 0.78,
    location_precision = 'kilometer_rnc',
    location_status = 'approximate',
    location_label = coalesce(nullif(location_label, ''), road || ' · km 117') || ' · poste kilométrico aproximado'
where location_status = 'unlocated'
  and latitude is null and longitude is null
  and kilometer = 117
  and road ilike '%Guadalajara%Colima%'
  and (state is null or lower(state) = 'jalisco')
  and event_at >= now() - interval '24 hours';

update public.alerts
set latitude = 18.849633359617624,
    longitude = -97.29896331195432,
    location_confidence = 0.78,
    location_precision = 'kilometer_rnc',
    location_status = 'approximate',
    location_label = coalesce(nullif(location_label, ''), road || ' · km 229') || ' · poste kilométrico aproximado'
where location_status = 'unlocated'
  and latitude is null and longitude is null
  and kilometer = 229
  and road ilike '%Acatzingo%Mendoza%'
  and (state is null or lower(state) in ('veracruz', 'veracruz de ignacio de la llave'))
  and event_at >= now() - interval '24 hours';

commit;
