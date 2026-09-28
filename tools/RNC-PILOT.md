# Piloto de postes kilométricos RNC 2025

Fuente oficial: [INEGI, Red Nacional de Caminos 2025](https://www.inegi.org.mx/programas/rnc/#descargas), GeoPackage UPC 794551163030. El archivo incluye `red_vial` y `poste_de_referencia`. Los postes tienen posición aproximada según el [diccionario de datos](https://inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/nueva_estruc/889463927457.pdf); la capa proviene de un inventario histórico de SICT. Crédito: INEGI/IMT, RNC 2025.

El paquete comprimido pesa unos 910 MB y se procesa **fuera de producción**. Se usan `CODIGO=54` o `150` junto con `PEAJE=Si`; la RNC no codifica esas vías como `54D`/`150D` en el campo `CODIGO`.

```sh
curl -L --fail -o rnc2025.zip 'https://www.inegi.org.mx/contenidos/productos/prod_serv/contenidos/espanol/bvinegi/productos/geografia/caminos/2025/794551163030_gpk.zip'
unzip -p rnc2025.zip conjunto_de_datos/rnc2025.gpkg > rnc2025.gpkg
python3 tools/rnc-gpkg-extract.py rnc2025.gpkg /tmp/rnc-pilot
node tools/rnc-km-pilot.mjs /tmp/rnc-pilot/roads.geojson /tmp/rnc-pilot/posts.geojson /tmp/rnc-pilot/report.json
```

Los archivos nacionales y el reporte bruto no deben subirse al repositorio. El extractor usa `sqlite3` y decodificación GeoPackage estándar, sin dependencias externas. Acota los corredores a Jalisco/Colima y Puebla/Veracruz para revisión. El informe solo produce candidatos, no alimenta automáticamente al worker.

Hallazgos del paquete oficial: 54D: 88 postes candidatos, 80 kilómetros distintos; 150D: 228 candidatos, 206 kilómetros distintos. Hay kilómetros repetidos, ramales y valores anómalos (por ejemplo 7090/7140). Por eso el piloto operativo incorpora **solo dos postes exactos** comprobados sobre los ejes de cuota: 54D km 117 (`ID_KM=40870`, `ID_RED=546230`, Jalisco) y 150D Acatzingo–Ciudad Mendoza km 229 (`ID_KM=5725`, `ID_RED=184962`, Veracruz). Un reverse de control confirmó esas entidades; el worker vuelve a verificar el estado para cada alerta. Se muestran como referencia aproximada con radio de 1.5 km, no como ubicación exacta del accidente. Otros kilómetros siguen en la lista sin pin.

Antes de ampliar el índice: distinguir variantes de cadenamiento, sentido, libre/cuota y carreteras paralelas; descartar kilómetros duplicados y saltos; contrastar varios postes consecutivos contra el eje vial y la entidad federativa. Después del despliegue, revisar y ejecutar `supabase/migrations/20260928_rnc_pilot_backfill.sql` para alertas aún vigentes y sin coordenadas que coincidan exactamente con los dos casos. Las filas con estado incompatible no se modifican.

## Ampliación revisada de la 150D

`worker/rnc-150d-reviewed.json` incorpora 23 postes exactos del informe de la RNC: km 197–201, 205–206, 208–209, 211–222, 229–230. Son los kilómetros **presentes y únicos**, no puntos interpolados para los huecos. Los ID de poste y tramo vial quedan en el archivo para auditoría. Sus coordenadas siguen el cadenamiento de la vía de cuota (por ejemplo, los km 211–222 avanzan alrededor de 1 km por poste); se contrastaron varios puntos a ambos lados con un reverse de entidad federativa: Puebla hasta el km 222 y Veracruz en 229–230. El worker exige coincidencia de nombre y km exactos y rechaza una entidad declarada incompatible; la verificación normal de estado del pipeline también se conserva.

Los km 223–226 y 231 en adelante tienen referencias repetidas o ramales que requieren distinguir sentido/cadenamiento antes de habilitarlos. Tampoco se interpolan los km ausentes 202–204, 207, 210 y 228. La posición de cada poste es aproximada y no garantiza el punto del incidente.

Tras desplegar el worker, `supabase/migrations/20260928_rnc_150d_reviewed_backfill.sql` puede actualizar alertas vigentes sin coordenadas, con carretera y km exactos y estado compatible. Excluye el km 229 ya cubierto por el backfill del piloto.
