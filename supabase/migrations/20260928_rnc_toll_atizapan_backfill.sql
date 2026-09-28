-- Run only after deployment of the RNC plaza catalog and toll-reference UI.
-- Reference location of the toll plaza, not the exact position of an incident.
begin;

update public.alerts as a
set latitude = 19.58254042,
    longitude = -99.27111721,
    location_confidence = 0.90,
    location_precision = 'toll_reference',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · Plaza de Cobro Atizapán') || ' · caseta como referencia aproximada'
where a.location_status = 'unlocated'
  and a.latitude is null and a.longitude is null
  and a.road ilike '%Chamapa%Lecher%'
  and a.location_label ilike '%Plaza de Cobro Atizapán%'
  and a.kilometer = 10
  and (a.state is null or lower(a.state) in ('estado de méxico', 'méxico', 'edomex'))
  and a.event_at >= now() - interval '24 hours';

commit;
