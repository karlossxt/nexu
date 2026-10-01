# Plazas de cobro RNC 2025

La capa `plaza_cobro` del GeoPackage oficial RNC contiene nombre, tramo y punto de cada plaza. Se agrupan carriles de una misma plaza por nombre/tramo; solo se incorporan grupos cuyos puntos están a 250 m o menos del centro. Se excluyen nombres/tramos vacíos y grupos dispersos. El catálogo resultante es `worker/rnc-toll-plazas.json`.

```sh
node tools/rnc-toll-plazas.js /ruta/rnc2025.gpkg worker/rnc-toll-plazas.json
node --test tools/test_rnc_toll_plazas.js
node --test worker/rnc-toll-reference.test.js
```

El barrido de 1,376 puntos produjo **663 plazas nombradas con tramo coherente**. Excluyó 233 puntos sin nombre/tramo y 93 de grupos demasiado dispersos. Cada registro conserva `sourceIds` (`ID_PLAZA`), tramo oficial, centro y dispersión de los carriles.

El port a Node reproduce el catálogo **byte a byte** contra el que ya está en `worker/rnc-toll-plazas.json` (SHA-256 `BEA4A09A…300E2`), así que regenerarlo no introduce deriva. Dos detalles no evidentes: la dispersión escala la longitud por el coseno de la latitud del grupo (sin eso un corredor este-oeste parece más disperso que uno norte-sur del mismo ancho), y `sourceIds` se ordena numéricamente — el `sort()` por defecto de JS ordenaría `[10, 2, 9]`.

El worker acepta la plaza cuando la referencia textual coincide exactamente con su nombre normalizado y, si la alerta declara carretera, el tramo coincide también con esa carretera. Un nombre repetido en varios tramos sin identidad suficiente no recibe pin. La verificación final de entidad federativa sigue vigente. La caseta es una **referencia aproximada** para incidentes en sus accesos; no equivale al punto exacto del choque.

Caso revisado: RNC `ID_PLAZA=730,731` sitúa la Plaza de Cobro Atizapán sobre Chamapa–Lechería en 19.58254042, -99.27111721, con 5 m de dispersión entre carriles. [CAPUFE](https://iave.capufe.gob.mx/assets/imgs/quienesomos/beneficios/Redes-Carreteras-IAVE.pdf) y [SICT](https://app.sct.gob.mx/sibuac_internet/ControllerUI?action=cmdReporteCasetas) la identifican en el km 9+850 de ese tramo. Para las alertas ya almacenadas sin punto, ejecutar `supabase/migrations/20260928_rnc_toll_atizapan_backfill.sql` solo después del despliegue.
