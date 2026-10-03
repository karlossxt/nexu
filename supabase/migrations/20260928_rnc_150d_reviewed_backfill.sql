-- Run only after the expanded 150D worker/frontend is deployed.
-- Exact reviewed RNC 2025 posts; never interpolate across missing or duplicate km.
-- Retain alerts without a verified post as unlocated.
begin;

with reviewed(km,lat,lon,expected_state) as (
  values
  (197, 18.857934761122294, -97.54991182192217, 'Puebla'),
  (198, 18.852920847098353, -97.54198622793898, 'Puebla'),
  (199, 18.84808786230911, -97.53439075080377, 'Puebla'),
  (200, 18.842765425479737, -97.52601101869513, 'Puebla'),
  (201, 18.837780961157637, -97.51815997589988, 'Puebla'),
  (205, 18.830443658805535, -97.48439177290564, 'Puebla'),
  (206, 18.833410473846246, -97.47549886105722, 'Puebla'),
  (208, 18.835045832425607, -97.46219355461982, 'Puebla'),
  (209, 18.83768859266196, -97.45457197939339, 'Puebla'),
  (211, 18.845600337886587, -97.4372304784056, 'Puebla'),
  (212, 18.849429606449323, -97.4288065198834, 'Puebla'),
  (213, 18.853372372281875, -97.4201836749943, 'Puebla'),
  (214, 18.857130774121295, -97.41192150993504, 'Puebla'),
  (215, 18.86098685145085, -97.40377876992078, 'Puebla'),
  (216, 18.86695359845752, -97.39519515485918, 'Puebla'),
  (217, 18.872180190119856, -97.38907424969774, 'Puebla'),
  (218, 18.86835171987279, -97.38083945205827, 'Puebla'),
  (219, 18.864616332580642, -97.37278000719364, 'Puebla'),
  (220, 18.86065408519784, -97.3642231439088, 'Puebla'),
  (221, 18.8548951432824, -97.35733228541409, 'Puebla'),
  (222, 18.84787313023864, -97.35131075544614, 'Puebla'),
  (230, 18.855609149188613, -97.29680611963326, 'Veracruz')
)
update public.alerts as a
set latitude = reviewed.lat,
    longitude = reviewed.lon,
    location_confidence = 0.78,
    location_precision = 'kilometer_rnc',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · km ' || a.kilometer) || ' · poste kilométrico aproximado'
from reviewed
where a.location_status = 'unlocated'
  and a.latitude is null and a.longitude is null
  and a.kilometer = reviewed.km
  and a.road ilike '%Acatzingo%Mendoza%'
  and (a.state is null
       or (reviewed.expected_state = 'Puebla' and lower(a.state) = 'puebla')
       or (reviewed.expected_state = 'Veracruz' and lower(a.state) in ('veracruz', 'veracruz de ignacio de la llave')))
  and a.event_at >= now() - interval '24 hours';

commit;
