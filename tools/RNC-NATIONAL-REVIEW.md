# Revisión nacional de postes RNC 2025

Genera **candidatos para revisión**, nunca coordenadas de producción. Parte del GeoPackage oficial descargado según [RNC-PILOT.md](RNC-PILOT.md). No requiere llaves, proveedores de geocodificación ni dependencias Python externas.

```sh
python3 tools/rnc-national-review.py /ruta/rnc2025.gpkg /tmp/rnc-national-review.json
python3 -m unittest tools/test_rnc_national_review.py
```

El JSON completo se mantiene fuera del repositorio. Incluye `chains` (postes, `ID_KM`, `ID_RED`, coordenadas originales y proyectadas, distancia de ajuste) y `flaggedPosts` con la causa de exclusión. `status=review_required` significa que **ninguna cadena está aprobada por este programa**.

## Reglas conservadoras

- Busca cada poste con el índice espacial del GeoPackage en un radio de 120 m; solo propone segmentos de cuota (`PEAJE=Si`), código numérico y nombre identificable. Un segmento libre u otra ruta a menos de 30 m de diferencia en el ajuste marca el poste como ambiguo.
- Rechaza **todos** los postes de un km repetido dentro del mismo código, aun si uno está más cerca del vecino anterior. Una cadena tampoco puede saltar por encima de un km duplicado.
- Forma cadenas de al menos cuatro postes del mismo código y nombre de tramo. Solo une diferencias de hasta 3 km con distancia geográfica coherente (holgura para curvas y posición aproximada). Los fragmentos cortos quedan para revisión.
- No asigna `54D` o `150D` desde `CODIGO`: guarda `54`/`150` más `toll=true`. Tampoco convierte nombres internos de tramo en alias públicos ni extrapola/interpola coordenadas operativas.
- Un poste que aparece en `chains` aún necesita confirmar entidad, vía de cuota, cadenamiento, dirección/ramal y vecinos contra la geometría antes de pasar al índice del worker.

### Primer barrido completo

RNC 2025: 46,289 postes examinados; 5,567 próximos a un segmento de cuota nombrado y no ambiguo en la asignación; **127 cadenas candidatas con 2,296 postes**. Se marcaron 39,803 sin cuota nombrada a 120 m, 305 próximos también a libre/otro código, 16 con nombre de tramo ambiguo, 2,887 registros de km repetidos, 598 km extremos/inválidos y 384 postes aislados o en fragmentos cortos. Los descartes son deliberados, no fallos de ingestión.

Controles conocidos: el km 117 de la 54D (`ID_KM=40870`) queda en cadena; los dos km 223 de la 150D se excluyen; el km 229 (`ID_KM=5725`) queda aislado en este barrido y conserva su revisión individual previa. El km 104 de la 54D sigue siendo una estimación revisada entre postes, no un poste de la RNC.

### Anclas independientes opcionales

Para comparar con casetas u otras referencias **que incluyan el código de ruta verificado**, preparar un JSON externo:

```json
[{"code":"150","name":"Acatzingo - Ciudad Mendoza","km":200,"lat":18.84,"lon":-97.52}]
```

```sh
python3 tools/rnc-national-review.py /ruta/rnc2025.gpkg /tmp/rnc-national-review.json --anchors /ruta/anclas-verificadas.json
```

El ejemplo de coordenadas es solo formato. No debe usarse como ancla real. El resultado `anchorValidation` exige una única cadena del **mismo código** y, si se proporciona, el mismo nombre de tramo; no acepta la predicción más cercana de cualquier ruta. Una ancla derivada de los propios postes RNC no cuenta como validación independiente.

## Priorización por alertas reales

Exportar a JSON las alertas con `id,road,kilometer,state,event_at,latitude,longitude,location_status` y ejecutar:

```sh
python3 tools/rnc-batch-review.py alerts.json /tmp/rnc-national-review.json /tmp/rnc-prioritized.json
python3 -m unittest tools/test_rnc_batch_review.py
```

Agrupa carretera y km, ordena por frecuencia y solo propone coincidencias de nombre completo y km cubierto por una cadena candidata. `exact_post_needs_review` **no aprueba el punto**: todavía hay que confirmar entidad, cuota/libre, ramal, cadenamiento y vecinos. `no_matching_chain` evita confundir Zacapalco–Rancho Viejo con Zacapalco–Taxco. El script no escribe en Supabase ni en el índice del worker.

Para ordenar primero los corredores con aforos conocidos, añadir un cuarto argumento con registros `road,tdpa,year,station,stationKm,source`:

```sh
python3 tools/rnc-batch-review.py alerts.json /tmp/rnc-national-review.json /tmp/rnc-prioritized.json tools/traffic-2024-samples.json
```

`traffic-2024-samples.json` contiene **tres mediciones puntuales** publicadas por SICT en Datos Viales 2025 (aforos 2024), no un ranking nacional ni el promedio de cada carretera. Al incorporar el conjunto nacional completo se podrá ordenar el resto de corredores por TDPA comparable. Un valor alto solo define el orden de revisión; nunca aprueba una coordenada. Las alertas sin muestra permanecen en el reporte.
