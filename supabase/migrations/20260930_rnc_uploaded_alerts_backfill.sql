-- Reviewed RNC 2025 exact reference posts; pins remain approximate (1.5 km).
-- Only uploaded September 30 CAPUFE titles, in the uploaded list's 24-hour window (CDMX Sep 29 22:48 to Sep 30 22:48).
-- Existing coordinates are excluded. Safe to rerun: updated rows stop matching.
BEGIN;
WITH anchors(km, lat, lon, expected_state, road_pattern) AS (VALUES
  (282, 18.899710620755304, -97.03679808740777, 'Veracruz', '^(Autopista[[:space:]]+)?(Cd[.]?|Ciudad)[[:space:]]*Mendoza[[:space:]]*[-–—][[:space:]]*C[oó]rdoba$'),
  (285, 18.907048327555657, -97.01059927943602, 'Veracruz', '^(Autopista[[:space:]]+)?(Cd[.]?|Ciudad)[[:space:]]*Mendoza[[:space:]]*[-–—][[:space:]]*C[oó]rdoba$'),
  (286, 18.90692782851448, -97.00099003590323, 'Veracruz', '^(Autopista[[:space:]]+)?(Cd[.]?|Ciudad)[[:space:]]*Mendoza[[:space:]]*[-–—][[:space:]]*C[oó]rdoba$'),
  (289, 18.895281070432667, -96.97861849246151, 'Veracruz', '^(Autopista[[:space:]]+)?(Cd[.]?|Ciudad)[[:space:]]*Mendoza[[:space:]]*[-–—][[:space:]]*C[oó]rdoba$'),
  (6, 18.998496603783565, -99.12503293940631, 'Morelos', '^(Autopista[[:space:]]+)?La[[:space:]]+Pera[[:space:]]*[-–—][[:space:]]*Cuautla$'),
  (25, 18.912512887640165, -98.99602752017226, 'Morelos', '^(Autopista[[:space:]]+)?La[[:space:]]+Pera[[:space:]]*[-–—][[:space:]]*Cuautla$'),
  (7, 18.03052122500765, -94.36090684300267, 'Veracruz', '^(Autopista[[:space:]]+)?Nuevo[[:space:]]+Teapa[[:space:]]*[-–—][[:space:]]*Cosoleacaque$'),
  (63, 19.024862350303803, -99.16868799065422, 'Morelos', '^(Autopista[[:space:]]+)?M[eé]xico[[:space:]]*[-–—][[:space:]]*Cuernavaca$')
), requested(id, km, title) AS (VALUES
  ('d6a7952c-4058-4a0f-9972-ab3e2c4da16b', 63.0, 'Accidente por volcadura de automóvil provoca cierre parcial en la Autopista México-Cuernavaca km 63'),
  ('511c2528-99f7-40f1-a9d1-6702363dc1a0', 286.0, 'Se restablece la circulación en la autopista Cd. Mendoza - Córdoba tras un accidente'),
  ('dbcfff9d-3342-4273-853e-e9a8e06faf0e', 286.0, 'Accidente vial provoca reducción de carriles en la autopista Cd. Mendoza a Córdoba'),
  ('a30a4815-4571-411a-a769-928137023d16', 6.0, 'Se restablece la circulación en la autopista La Pera - Cuautla tras un accidente'),
  ('a41d1f9c-d8dd-4fb6-8a89-8904d2a99203', 7.0, 'Se restablece la circulación en la autopista Nuevo Teapa - Cosoleacaque tras un accidente'),
  ('9bd07e1a-3c3f-414c-b2ae-4b50fd2f5bc1', 6.0, 'Accidente vehicular provoca cierre parcial en la autopista La Pera - Cuautla km 6'),
  ('4674d17b-a67b-4086-a5fc-a622d7b17042', 25.0, 'Se restablece la circulación en la autopista La Pera - Cuautla tras incidente atendido'),
  ('b940ab8c-3c50-450c-8354-97225c963f82', 25.0, 'Reducción de carriles en autopista La Pera - Cuautla por autobús con falla mecánica'),
  ('e0ec7ac1-e02b-4b31-9bf1-4e80f1475cee', 7.0, 'Accidente vial provoca cierre parcial en la autopista Nuevo Teapa a Cosoleacaque km 7'),
  ('e1b6db39-d703-4b52-abc8-bad647cbcd4e', 63.0, 'Se restablece la circulación en la autopista México-Cuernavaca tras atender un accidente vial'),
  ('29d9465e-be19-479c-a80b-7e783c733d23', 63.0, 'Reducción de carriles en la Autopista México-Cuernavaca por choque contra muro central'),
  ('a07653f3-24c7-47e8-9920-839bb857f37d', 282.0, 'Se restablece la circulación en la autopista Cd Mendoza - Córdoba tras un accidente'),
  ('24330369-70c5-4d36-8630-fd172c67fd00', 285.0, 'Reducción de carriles por tractocamión con falla mecánica en autopista Cd. Mendoza Córdoba'),
  ('00526ca3-7cba-4363-aed2-2ed193a3d6df', 282.0, 'Se registra carga vehicular en la autopista Cd Mendoza - Córdoba, kilómetro 282'),
  ('7d977e8e-73b9-4f72-95a5-212bd058581e', 282.0, 'Cierre parcial en autopista Cd Mendoza - Córdoba km 282 por accidente vial'),
  ('3d8b7950-78e3-40cb-bc78-005d0773e05b', 282.0, 'Accidente con incendio de unidades en la autopista Cd Mendoza Córdoba kilómetro 282'),
  ('59c55038-5b46-47dc-8739-020314ec733e', 282.0, 'Cierre total en autopista Cd Mendoza - Córdoba por choque e incendio de unidades'),
  ('e8580b3d-342b-4f53-bcd5-6ef63f6c1b47', 282.0, 'Cierre total en autopista Cd Mendoza a Córdoba por choque e incendio vehicular'),
  ('4fba9293-9117-4b3b-9124-6daa91103d44', 289.0, 'Se restablece la circulación en la autopista Cd. Mendoza - Córdoba tras un accidente'),
  ('e41a7aa1-ebc2-4ec1-bb3e-56a347725a65', 289.0, 'Cierre parcial por accidente en la autopista Cd. Mendoza - Córdoba, kilómetro 289'),
  ('d4b1e6ab-ce3a-465c-9f9f-d982ed4cea7f', 289.0, 'Cierre parcial por choque de tractocamiones en la autopista Cd. Mendoza a Córdoba')
)
UPDATE public.alerts AS a
SET latitude = p.lat,
    longitude = p.lon,
    location_confidence = 0.78,
    location_precision = 'kilometer_rnc',
    location_status = 'approximate',
    location_label = coalesce(nullif(a.location_label, ''), a.road || ' · km ' || a.kilometer)
        || ' · poste RNC como referencia aproximada'
FROM anchors AS p, requested AS r
WHERE a.id = r.id::uuid AND a.kilometer = p.km AND r.km = p.km AND a.title = r.title
  AND a.road ~* p.road_pattern
  AND lower(coalesce(a.source_name, '')) LIKE '%capufe%'
  AND (nullif(trim(a.state), '') IS NULL
       OR lower(trim(a.state)) = lower(p.expected_state)
       OR (p.expected_state = 'Veracruz' AND lower(trim(a.state)) = 'veracruz de ignacio de la llave'))
  AND a.location_status = 'unlocated'
  AND a.latitude IS NULL AND a.longitude IS NULL
  AND a.event_at >= timestamptz '2026-09-30 04:48:00+00'
  AND a.event_at < timestamptz '2026-10-01 04:48:03+00'
RETURNING a.id, a.title, a.road, a.kilometer, a.latitude, a.longitude;
-- Shared OSM geometry node of Chapultepec (way 52834958) and Cuauhtémoc
-- (ways 33812474 / 348442982), San Gregorio Atlapulco. Intersection reference,
-- not a GPS measurement of the incident. The frontend displays a 250 m radius.
UPDATE public.alerts AS a
SET kilometer = NULL,
    latitude = 19.2552226,
    longitude = -99.0559331,
    location_confidence = 0.80,
    location_precision = 'intersection',
    location_status = 'approximate',
    location_label = 'Av. Chapultepec y Av. Cuauhtémoc · San Gregorio Atlapulco, Xochimilco · cruce localizado en cartografía'
WHERE a.id = '87cf2686-a5e2-4068-90b7-6de23a223145'::uuid
  AND a.title = 'Manifestantes bloquean la circulación en el cruce de Av. Chapultepec y Cuauhtémoc, Xochimilco'
  AND lower(coalesce(a.source_name, '')) LIKE '%scpp%'
  AND a.location_label ~* 'Chapultepec'
  AND a.location_label ~* 'Cuauht[eé]moc'
  AND (nullif(trim(a.state), '') IS NULL OR lower(trim(a.state)) IN ('cdmx', 'ciudad de méxico', 'ciudad de mexico', 'distrito federal'))
  AND (nullif(trim(a.municipality), '') IS NULL OR lower(trim(a.municipality)) = 'xochimilco')
  AND (a.kilometer IS NULL OR a.kilometer = 0)
  AND a.location_status = 'unlocated'
  AND a.latitude IS NULL AND a.longitude IS NULL
  AND a.event_at >= timestamptz '2026-09-30 04:48:00+00'
  AND a.event_at < timestamptz '2026-10-01 04:48:03+00'
RETURNING a.id, a.title, a.latitude, a.longitude;
COMMIT;
