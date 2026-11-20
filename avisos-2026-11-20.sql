-- Cierres viales programados del 20 de noviembre de 2026 (desfiles y obra en Tultitlán).
-- Coordenadas APROXIMADAS (centro de la zona): precision 'zone' / status 'approximate'.
-- Si corres el script dos veces no duplica (external_id único).
insert into public.alerts
 (external_id,title,detail,category,severity,event_type,traffic_status,state,municipality,location_label,latitude,longitude,location_confidence,location_precision,location_status,source_name,event_at)
values
('aviso:2026-11-20:tlalnepantla-desfile',
 'Cierres en el primer cuadro de Tlalnepantla por desfile cívico (6:00 a 11:00 h)',
 'Cierre programado. Horario: 6:00 a 11:00 h. Afectaciones en Av. Río Lerma, Av. Ayuntamiento, Calle Roberto Fulton, Av. Sor Juana Inés de la Cruz y calles aledañas como Av. Morelos y Av. Presidente Benito Juárez. Posible afectación de vialidades.',
 'road','medium','scheduled_mobilization','scheduled','Estado de México','Tlalnepantla de Baz','Centro de Tlalnepantla',
 19.5400,-99.1950,0.5,'zone','approximate','Aviso vial municipal','2026-11-20T06:00:00-06:00'),
('aviso:2026-11-20:izcalli-desfile',
 'Cortes viales en Cuautitlán Izcalli por el recorrido del desfile (desde las 8:00 h)',
 'Cierre programado desde las 8:00 h. Recorrido desde la Torre de Telmex (Av. de las Musas, Col. Ensueños) hasta el Estadio Hugo Sánchez (Col. Cumbria), con cierres desde Av. de las Esfinges en dirección a Av. Constitución. Posible afectación de vialidades.',
 'road','medium','scheduled_mobilization','scheduled','Estado de México','Cuautitlán Izcalli','Av. de las Musas – Estadio Hugo Sánchez',
 19.6590,-99.2150,0.4,'zone','approximate','Aviso vial municipal','2026-11-20T08:00:00-06:00'),
('aviso:2026-11-20:cuautitlan-desfile',
 'Cierres parciales en el centro de Cuautitlán por desfile cívico-deportivo (6:00 a 12:30 h)',
 'Cierre programado. Horario: 6:00 a 12:30 h. Cierres parciales en distintas vialidades del centro. Posible afectación de vialidades.',
 'road','medium','scheduled_mobilization','scheduled','Estado de México','Cuautitlán','Centro de Cuautitlán',
 19.6713,-99.1786,0.5,'zone','approximate','Aviso vial municipal','2026-11-20T06:00:00-06:00'),
('aviso:2026-11-20:tultitlan-asta-bandera',
 'Cierre por obras en la rampa del Puente del Asta Bandera, Tultitlán (a partir del 20 de noviembre)',
 'Cierre por obras de rehabilitación en la rampa del Puente del Asta Bandera. Afecta la incorporación desde Hermenegildo Galeana y la vía José López Portillo hacia Boulevard Tultitlán. Posible afectación de vialidades.',
 'road','medium','scheduled_mobilization','allday','Estado de México','Tultitlán','Puente del Asta Bandera',
 19.6168,-99.1676,0.4,'zone','approximate','Aviso vial municipal','2026-11-20T00:00:00-06:00')
on conflict (external_id) do nothing;
