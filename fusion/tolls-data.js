/* ============================================================================
   ZERO VIAL · FUSIÓN · Catálogo de casetas con tarifas (portado de VíaSegura)
   Datos orientativos de tarifas CAPUFE/RCO/IDEAL/PINFRA para la calculadora de
   peajes. No se usan para la capa visual del mapa (esa usa window.ZERO_VIAL_CASETAS).
   ============================================================================ */
window.FUSION_VEHICLE_LABELS = {
  moto:     { name: 'Motocicleta',            desc: 'Tarifa preferencial (~50%)' },
  auto:     { name: 'Automóvil / Sedán',       desc: 'Tarifa estándar turismo 2 ejes' },
  pickup:   { name: 'Camioneta / SUV',         desc: '2 ejes rodado sencillo' },
  autobus:  { name: 'Autobús de Pasajeros',    desc: '2, 3 y 4 ejes' },
  carga_c2: { name: 'Camión C2 / C3',          desc: 'Carga ligera / mediana (2 a 4 ejes)' },
  carga_c5: { name: 'Tractocamión C5 / Full',  desc: 'Articulado pesado 5 a 9 ejes' }
};

window.FUSION_FUEL_PRICES = {
  regular: { name: 'Gasolina Regular (Magna)', price: 23.90 },
  premium: { name: 'Gasolina Premium',          price: 25.50 },
  diesel:  { name: 'Diésel Automotriz',          price: 25.10 }
};

window.ZERO_VIAL_TOLLS = [
  { id:'caseta-tepotzotlan', name:'Caseta Tepotzotlán', highway:'Autopista México - Querétaro 57D', zone:'Centro', operator:'CAPUFE', lat:19.7150, lon:-99.2312, acceptsTag:true, prices:{ moto:53, auto:105, pickup:105, autobus:228, carga_c2:228, carga_c5:450 } },
  { id:'caseta-palmillas', name:'Caseta Palmillas', highway:'Autopista México - Querétaro 57D', zone:'Bajío', operator:'CAPUFE', lat:20.3204, lon:-99.9145, acceptsTag:true, prices:{ moto:53, auto:105, pickup:105, autobus:228, carga_c2:228, carga_c5:450 } },
  { id:'caseta-tlalpan', name:'Caseta Tlalpan', highway:'Autopista del Sol México - Cuernavaca 95D', zone:'Centro', operator:'CAPUFE', lat:19.2612, lon:-99.1678, acceptsTag:true, prices:{ moto:70, auto:140, pickup:140, autobus:252, carga_c2:252, carga_c5:490 } },
  { id:'caseta-paso-morelos', name:'Caseta Paso Morelos', highway:'Autopista del Sol Cuernavaca - Acapulco 95D', zone:'Sur-Sureste', operator:'CAPUFE', lat:18.2391, lon:-99.2154, acceptsTag:true, prices:{ moto:94, auto:188, pickup:188, autobus:375, carga_c2:375, carga_c5:680 } },
  { id:'caseta-palo-blanco', name:'Caseta Palo Blanco (Chilpancingo)', highway:'Autopista del Sol 95D', zone:'Sur-Sureste', operator:'CAPUFE', lat:17.4320, lon:-99.4751, acceptsTag:true, prices:{ moto:84, auto:168, pickup:168, autobus:310, carga_c2:310, carga_c5:590 } },
  { id:'caseta-la-venta', name:'Caseta La Venta (Entronque Acapulco)', highway:'Autopista del Sol 95D', zone:'Sur-Sureste', operator:'CAPUFE', lat:16.9248, lon:-99.8164, acceptsTag:true, prices:{ moto:75, auto:151, pickup:151, autobus:280, carga_c2:280, carga_c5:520 } },
  { id:'caseta-san-marcos', name:'Caseta San Marcos', highway:'Autopista México - Puebla 150D', zone:'Centro', operator:'CAPUFE', lat:19.3456, lon:-98.8789, acceptsTag:true, prices:{ moto:80, auto:156, pickup:156, autobus:312, carga_c2:312, carga_c5:585 } },
  { id:'caseta-san-martin', name:'Caseta San Martín Texmelucan', highway:'Autopista México - Puebla 150D', zone:'Sur-Sureste', operator:'CAPUFE', lat:19.2891, lon:-98.4215, acceptsTag:true, prices:{ moto:27, auto:54, pickup:54, autobus:120, carga_c2:120, carga_c5:230 } },
  { id:'caseta-amozoc', name:'Caseta Amozoc', highway:'Autopista Puebla - Orizaba 150D', zone:'Sur-Sureste', operator:'PINFRA', lat:19.0410, lon:-98.0512, acceptsTag:true, prices:{ moto:45, auto:89, pickup:89, autobus:178, carga_c2:178, carga_c5:340 } },
  { id:'caseta-arco-norte-atlacomulco', name:'Caseta Arco Norte - Atlacomulco', highway:'Libramiento Norte de la Cd. de México (M40D)', zone:'Centro', operator:'IDEAL', lat:19.7891, lon:-99.8821, acceptsTag:true, prices:{ moto:70, auto:140, pickup:140, autobus:310, carga_c2:310, carga_c5:640 } },
  { id:'caseta-sabinas-hidalgo', name:'Caseta Sabinas Hidalgo', highway:'Autopista Monterrey - Nuevo Laredo 85D', zone:'Norte', operator:'CAPUFE', lat:26.5012, lon:-100.1782, acceptsTag:true, prices:{ moto:165, auto:330, pickup:330, autobus:540, carga_c2:540, carga_c5:980 } },
  { id:'caseta-acatlan', name:'Caseta Acatlán de Juárez', highway:'Autopista Guadalajara - Colima 54D', zone:'Occidente', operator:'RCO', lat:20.4120, lon:-103.5891, acceptsTag:true, prices:{ moto:60, auto:120, pickup:120, autobus:240, carga_c2:240, carga_c5:460 } },
  { id:'caseta-san-marcos-colima', name:'Caseta San Marcos (Jalisco)', highway:'Autopista Guadalajara - Colima 54D', zone:'Occidente', operator:'RCO', lat:19.7214, lon:-103.5412, acceptsTag:true, prices:{ moto:88, auto:176, pickup:176, autobus:350, carga_c2:350, carga_c5:690 } }
];

window.ZERO_VIAL_TOLL_CORRIDORS = [
  { id:'cdmx-qro', name:'CDMX ➔ Querétaro (Autopista 57D)', distanceKm:218, tollIds:['caseta-tepotzotlan','caseta-palmillas'], freeRouteKm:245, freeRouteMinutesExtra:85 },
  { id:'cdmx-acapulco', name:'CDMX ➔ Acapulco (Autopista del Sol 95D)', distanceKm:379, tollIds:['caseta-tlalpan','caseta-paso-morelos','caseta-palo-blanco','caseta-la-venta'], freeRouteKm:420, freeRouteMinutesExtra:140 },
  { id:'cdmx-puebla', name:'CDMX ➔ Puebla (Autopista 150D)', distanceKm:132, tollIds:['caseta-san-marcos','caseta-san-martin'], freeRouteKm:154, freeRouteMinutesExtra:65 },
  { id:'mty-laredo', name:'Monterrey ➔ Nuevo Laredo (Autopista 85D)', distanceKm:220, tollIds:['caseta-sabinas-hidalgo'], freeRouteKm:238, freeRouteMinutesExtra:55 },
  { id:'gdl-colima', name:'Guadalajara ➔ Colima (Autopista 54D)', distanceKm:198, tollIds:['caseta-acatlan','caseta-san-marcos-colima'], freeRouteKm:230, freeRouteMinutesExtra:80 },
  { id:'puebla-veracruz', name:'Puebla ➔ Orizaba / Veracruz (Autopista 150D)', distanceKm:285, tollIds:['caseta-amozoc'], freeRouteKm:310, freeRouteMinutesExtra:95 },
  { id:'arco-norte', name:'Libramiento Arco Norte Completo (M40D)', distanceKm:223, tollIds:['caseta-arco-norte-atlacomulco','caseta-san-martin'], freeRouteKm:260, freeRouteMinutesExtra:110 }
];

window.ZERO_VIAL_SAFE_STOPS = [
  { id:'safe-palmillas-bp', name:'Parador Integral Palmillas (BP & El Parador)', highway:'Autopista México - Querétaro 57D', kmMarker:'Km 148', zone:'Bajío', rating:4.8, lat:20.3340, lon:-99.9210 },
  { id:'safe-cuernavaca-parador', name:'Parador El Polvorín', highway:'Autopista del Sol 95D', kmMarker:'Km 95', zone:'Centro', rating:4.6, lat:18.8912, lon:-99.2214 },
  { id:'safe-chilpancingo-gn', name:'Estación y Destacamento GN Chilpancingo', highway:'Autopista del Sol 95D', kmMarker:'Km 270', zone:'Sur-Sureste', rating:4.9, lat:17.5112, lon:-99.5021 },
  { id:'safe-arco-norte-pachuca', name:'Mega Parador Arco Norte (Entronque Pachuca)', highway:'Libramiento Arco Norte M40D', kmMarker:'Km 122', zone:'Centro', rating:4.5, lat:20.0210, lon:-98.7912 },
  { id:'safe-sabinas-laredo', name:'Parador Carga Segura Sabinas', highway:'Autopista Monterrey - Nuevo Laredo 85D', kmMarker:'Km 100', zone:'Norte', rating:4.7, lat:26.5210, lon:-100.1610 },
  { id:'safe-sayula-colima', name:'Parador Turístico Sayula - San Marcos', highway:'Autopista Guadalajara - Colima 54D', kmMarker:'Km 68', zone:'Occidente', rating:4.6, lat:19.8710, lon:-103.5821 }
];
