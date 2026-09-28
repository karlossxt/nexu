# Plazas de cobro RNC 2025

La capa `plaza_cobro` del GeoPackage oficial RNC contiene nombre, tramo y punto de cada plaza. Se agrupan carriles de una misma plaza por nombre/tramo; solo se incorporan grupos cuyos puntos están a 250 m o menos del centro. Se excluyen nombres/tramos vacíos y grupos dispersos. El catálogo resultante es `worker/rnc-toll-plazas.json`.

```sh
python3 tools/rnc-toll-plazas.py /ruta/rnc2025.gpkg worker/rnc-toll-plazas.json
node --test worker/rnc-toll-reference.test.js
```

El barrido de 1,376 puntos produjo **663 plazas nombradas con tramo coherente**. Excluyó 233 puntos sin nombre/tramo y 93 de grupos demasiado dispersos. Cada registro conserva `sourceIds` (`ID_PLAZA`), tramo oficial, centro y dispersión de los carriles.

El worker acepta la plaza cuando la referencia textual coincide exactamente con su nombre normalizado y, si la alerta declara carretera, el tramo coincide también con esa carretera. Un nombre repetido en varios tramos sin identidad suficiente no recibe pin. La verificación final de entidad federativa sigue vigente. La caseta es una **referencia aproximada** para incidentes en sus accesos; no equivale al punto exacto del choque.

Caso revisado: RNC `ID_PLAZA=730,731` sitúa la Plaza de Cobro Atizapán sobre Chamapa–Lechería en 19.58254042, -99.27111721, con 5 m de dispersión entre carriles. [CAPUFE](https://iave.capufe.gob.mx/assets/imgs/quienesomos/beneficios/Redes-Carreteras-IAVE.pdf) y [SICT](https://app.sct.gob.mx/sibuac_internet/ControllerUI?action=cmdReporteCasetas) la identifican en el km 9+850 de ese tramo. Para las alertas ya almacenadas sin punto, ejecutar `supabase/migrations/20260928_rnc_toll_atizapan_backfill.sql` solo después del despliegue.
