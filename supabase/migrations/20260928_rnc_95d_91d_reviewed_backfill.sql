-- Execute after worker deployment. Official RNC post positions are approximate,
-- not an incident GPS fix. Restricted to exact road + kilometre and recent rows.
begin;

update public.alerts as a
set latitude = case when a.kilometer = 142 then 18.529994817157206 else 18.402194431886052 end,
    longitude = case when a.kilometer = 142 then -99.20052082776984 else -99.48919214593606 end,
    location_confidence = 0.78,
    location_precision = 'kilometer_rnc',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · km ' || a.kilometer) || ' · poste RNC como referencia aproximada'
where a.location_status = 'unlocated'
  and a.latitude is null and a.longitude is null
  and a.event_at >= now() - interval '24 hours'
  and (
    (a.kilometer = 142 and a.road ~* '^(Autopista[[:space:]]+)?Cuernavaca[[:space:]]*[-–—][[:space:]]*Acapulco$'
      and (a.state is null or lower(a.state) = 'morelos'))
    or
    (a.kilometer = 48 and a.road ~* '^(Autopista[[:space:]]+)?Puente[[:space:]]+de[[:space:]]+Ixtla[[:space:]]*[-–—][[:space:]]*Iguala$'
      and (a.state is null or lower(a.state) = 'guerrero'))
  );

commit;
