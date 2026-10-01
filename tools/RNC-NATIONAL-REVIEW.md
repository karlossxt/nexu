# Revisión nacional de postes RNC 2025

Genera **candidatos para revisión**, nunca coordenadas de producción. Parte del GeoPackage oficial descargado según [RNC-PILOT.md](RNC-PILOT.md). No requiere llaves, proveedores de geocodificación ni dependencias externas: el GeoPackage es un SQLite y `node:sqlite` lo lee de forma nativa.

```sh
node tools/rnc-national-review.js /ruta/rnc2025.gpkg /ruta/rnc-national-review.json
node --test tools/test_rnc_national_review.js
```

`rnc-national-review.js` es un port fiel de `rnc-national-review.py`; el original se conserva como referencia y ya no es necesario para ejecutar la revisión. Los demás `tools/*.py` siguen requiriendo Python.

## Verificación del port a Node

El port reproduce exactamente la línea base documentada más abajo:

| Métrica | Documentado | Port a Node |
|---|---:|---:|
| postes examinados | 46,289 | 46,289 |
| asignados antes de la revisión de cadenas | 5,567 | 5,567 |
| cadenas candidatas | 127 | 127 |
| postes candidatos | 2,296 | 2,296 |
| sin cuota nombrada a 120 m | 39,803 | 39,803 |
| próximos también a libre/otro código | 305 | 305 |
| km repetidos | 2,887 | 2,887 |
| km extremos/inválidos | 598 | 598 |
| nombre de tramo ambiguo | 16 | 16 |
| aislados o en fragmentos cortos | 384 | 384 |

Controles comprobados sobre el JSON producido: el km 117 de la 54D (`ID_KM=40870`) queda en la cadena *Acatlán de Juárez - El Trapiche* km 106-128; los dos km 223 de la 150D (`ID_KM` 3998 y 4001) quedan en `duplicate_km_same_code` y ningún km 223 aparece en cadena del código 150; el km 229 (`ID_KM=5725`) queda aislado como `short_or_isolated_chain`; ningún código se convierte en `54D`/`150D` y toda cadena queda con `toll=true`.

La corrida completa tarda unos 4 s con los índices RTree del propio GeoPackage.

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
node tools/rnc-batch-review.js alerts.json /tmp/rnc-national-review.json /tmp/rnc-prioritized.json
node --test tools/test_rnc_batch_review.js
```

Agrupa carretera y km, ordena por frecuencia y solo propone coincidencias de nombre completo y km cubierto por una cadena candidata. `exact_post_needs_review` **no aprueba el punto**: todavía hay que confirmar entidad, cuota/libre, ramal, cadenamiento y vecinos. `no_matching_chain` evita confundir Zacapalco–Rancho Viejo con Zacapalco–Taxco. El script no escribe en Supabase ni en el índice del worker.

### Límites del coincidente por nombre

El empate es de lista de tokens **completa y en orden**: `autopista`, `carretera`, `de`, `del`, `la`, `el`, `cuota`, `federal` y `km` se eliminan, todo lo demás debe coincidir. Dos límites medidos sobre las 127 cadenas candidatas (55 nombres distintos) que conviene no confundir con un fallo del script:

| Caso | Alerta | RNC | Resultado |
| --- | --- | --- | --- |
| Abreviatura de topónimo | `Cd. Mendoza` | `Ciudad Mendoza` | No coincide: `cd` ≠ `ciudad` |
| Número de ruta en el nombre | `Carretera Federal 95 Cuernavaca - Acapulco` | `Cuernavaca - Acapulco` | No coincide: los dígitos no son palabra vacía |
| Nombre de corredor distinto | `Guadalajara - Colima` | `Acatlán de Juárez - El Trapiche` | No coincide: ningún orden de tokens los aproxima |

El primero y el segundo se pueden cerrar con una tabla de normalización. El tercero no: exige un **alias** por corredor, que es exactamente el campo `alias` de los JSON `rnc-*-reviewed.json` del repo. Mientras no exista esa tabla, `no_matching_chain` significa "sin coincidencia por nombre", no "sin anclas": revisar esos grupos a mano antes de concluir que no hay poste.

Para ordenar primero los corredores con aforos conocidos, añadir un cuarto argumento con registros `road,tdpa,year,station,stationKm,source`:

```sh
node tools/rnc-batch-review.js alerts.json /tmp/rnc-national-review.json /tmp/rnc-prioritized.json tools/traffic-2024-samples.json
```

`traffic-2024-samples.json` contiene **tres mediciones puntuales** publicadas por SICT en Datos Viales 2025 (aforos 2024), no un ranking nacional ni el promedio de cada carretera. Al incorporar el conjunto nacional completo se podrá ordenar el resto de corredores por TDPA comparable. Un valor alto solo define el orden de revisión; nunca aprueba una coordenada. Las alertas sin muestra permanecen en el reporte.

## Auditar calibraciones externas

Si se genera una calibración de `red-vial.js` a partir de postes cercanos a la geometría, contrastarla antes de llevarla al worker:

```sh
node tools/rnc-calibration-audit.js /ruta/corridor-calibration.json /tmp/rnc-national-review.json /tmp/rnc-calibration-audit.json
node --test tools/test_rnc_calibration_audit.js
```

La auditoría conserva solo postes con ID presente en una cadena de la revisión nacional: tramo de cuota nombrado igual, sin código/km duplicado y con saltos de hasta 3 km. Separa secuencias de al menos cuatro postes. El resultado siempre dice `review_required`; no valida por sí solo el sentido, la geometría completa ni un error de interpolación independiente. Un poste rechazado por la revisión nacional no se rehabilita solo porque caiga cerca de la polilínea OSRM.

`detalleAnclas` debe traer los **ID reales** de la revisión nacional, no un rango inventado. El `ID_KM` del RNC **no sigue el sentido de la carretera**: en la cadena del 150 km 273-300 los IDs bajan de 6270 (km 273) a 6248 (km 300). Un rango inventado sobre IDs contiguos produce anclas que no existen; la auditoría las descarta en silencio y devuelve `segments: []`. Para comprobar si un tramo propuesto se sostiene, imprimir antes los IDs de la cadena:

```sh
node -e "const n=require('/tmp/rnc-national-review.json');const c=n.chains.find(c=>c.code==='150'&&c.fromKm===273);console.log(c.posts.map(p=>p.id+'(km '+p.km+')').join(', '))"
```

Un `segments: []` con `candidateAnchors` mayor que cero casi siempre significa IDs propuestos que no están en cadena, no un corredor sin posts.

## Invariante de plaza de cobro

Tercera fuente independiente, opcional, para **separar coincidencia de desacuerdo** en las cadenas candidatas. No aprueba ni corrige nada.

```sh
node tools/build-toll-plaza-verification.js /ruta/rnc2025.gpkg /tmp/plaza-verification.json
node tools/rnc-plaza-invariant-run.js /tmp/rnc-national-review.json /tmp/plaza-verification.json /tmp/plaza-invariant.json
node --test tools/test_rnc_plaza_invariant.js
```

El índice agrupa por `ID_RED` de cuota los tramos a 120 m de una plaza declarada, con tres compuertas: código único entre los candidatos, código numérico 1-999, y si `SECCION` resuelve a un solo código, que ese código sea el geométrico. Sobre RNC 2025 deja **1,692 `ID_RED` en 54 códigos, desde 832 anclas** (de 1,376 plazas: 338 sin código numérico, 145 sin vía de cuota cerca, 44 ambiguas, 17 en conflicto de nombre). Cada entrada guarda el par plaza↔`SECCION` con su `snapM`, para que un desacuerdo diga qué plaza revisar.

El invariante se evalúa **por segmento, no por código**, y eso cambia el resultado. Por código las 127 cadenas parecen cubiertas; por `ID_RED` solo lo están 32. El código no discrimina: el 15 cubre 39 secciones declaradas, el 150 llega a 21. El `ID_RED` sí.

| Veredicto | Cadenas | Significado |
|---|---:|---|
| `exact` | 20 | la plaza declara exactamente ese tramo |
| `shares_toponym` | 7 | mismo corredor, segmentación distinta de plaza |
| `different` | 5 | la plaza declara **otro** tramo: revisar alias |
| `no_plaza_on_road_ids` | 95 | invariante mudo: ninguna plaza toca esos `ID_RED` |

Los 95 mudos son el dato principal: **el invariante no corrobora la mayoría de las cadenas** porque 39,704 de 46,289 postes están sobre vía libre, y 1,376 plazas no alcanzan a cubrirlos. La distancia mediana de un poste a su plaza más cercana es 35 km. Estirar el radio no ayuda: a 250 m y 500 m el número de anclas cae, porque se mezclan códigos.

Los 5 `different` son los que valen la pena revisar, y ninguno se resuelve por cercanía:

| Código | Cadena | Sección declarada por la plaza |
|---|---|---|
| 15 | Atlacomulco - Zapotlanejo | Copándaro - Ent. Morelia |
| 150 | Córdoba - Veracruz | Cuitláhuac - La Tinaja |
| 180 | Mérida - Cancún | Kantunil - Pisté, Kantunil - Valladolid, Pisté - Valladolid |
| 54 | Acatlán de Juárez - El Trapiche | Atoyac - Ciudad Guzmán, Atoyac - Cuidad Guzmán |
| 57 | México - Querétaro | Joroba - Tepeji (CONMEX), Jorobas - Tepeji |

La clasificación no usa coincidencia exacta. Una `SECCION` de plaza es un **subsegmento** del corredor, no el corredor entero: `Paso del Toro - Veracruz` es un tramo de `Córdoba - Veracruz` y no es un conflicto, igual que la dirección invertida `Gómez Palacio - Jiménez` / `Jiménez - Gómez Palacio`. Se comparte topónimo con significado, conservando los dígitos porque en un nombre de tramo suelen ser parte del topónimo (`16 de Septiembre`) y no una medida de ruta. Por eso `Cuitláhuac - La Tinaja` frente a `Córdoba - Veracruz` sale `different` siendo el mismo corredor: es un caso que la tabla marca para revisión manual, no un error demostrado.

`rnc-national-review.js` acepta además `--plaza-verification <archivo>` para que un tramo de cuota sin nombre propio tome el de un tramo corroborado, marcado `nameSource: 'toll_plaza_verified'`. **Medido sobre RNC 2025, rescata 0 postes** y no cambia ninguna métrica de la revisión (5,566 asignados, 127 cadenas, 2,296 candidatos). Los descartes son correctos, no un bug: 87.1% de los postes están sobre vía libre y casi ninguno de los de cuota cae en un tramo sin nombre que una plaza declare. Queda disponible por si el dataset cambia, no porque sirva hoy.
