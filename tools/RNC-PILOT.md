# Piloto de cadenamiento RNC

Fuente: Red Nacional de Caminos 2025 de INEGI/IMT. El diccionario de datos identifica `Poste de referencia` (`Km`, `Id_Km`) y `Red vial` (`Codigo`, `Id_Red`, `Nombre`). La posición del poste se califica como aproximada y parte de un inventario histórico. Por ello el reporte es **para revisión**; no autoriza pines automáticamente.

Descarga oficial: https://www.inegi.org.mx/programas/rnc/#descargas o https://rnc.imt.mx/tablero/ (por capas: red vial e hito kilométrico). Convierte ambas capas SHP a GeoJSON WGS84 con GDAL:

```sh
ogr2ogr -t_srs EPSG:4326 -f GeoJSON roads.geojson Red_Vial.shp
ogr2ogr -t_srs EPSG:4326 -f GeoJSON posts.geojson Poste_Referencia.shp
node tools/rnc-km-pilot.mjs roads.geojson posts.geojson report.json
```

Los nombres exactos de los `.shp` pueden variar con el paquete. No subas al repositorio los archivos nacionales completos. El script acepta propiedades `Codigo`, `Id_Red`, `Nombre` y `Km`, `Id_Km` (sin distinguir mayúsculas), filtra 54D y 150D, y entrega coordenadas candidatas, distancia al eje vial, duplicados y cruces ambiguos.

Para aprobar un tramo se necesita comprobar manualmente el código de vía, dos postes consecutivos, continuidad del recorrido, sentido del cadenamiento, posibles reinicios y carretera libre/cuota. El resultado aprobado debe llevar fuente, edición y margen de error; los avisos fuera del tramo o con varias soluciones quedan `unlocated`. En particular, km 117 de 54D y km 229 de 150D requieren revisión individual antes de incorporarse al worker.
