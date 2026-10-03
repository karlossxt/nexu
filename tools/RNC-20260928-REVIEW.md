# Postes revisados para alertas del 28 de septiembre

El informe nacional `rnc-national-review.json` (RNC 2025) contiene cadenas candidatas; esta revisión incorpora solo dos postes exactos del eje de cuota. La posición del poste es una referencia aproximada, no el lugar GPS del accidente.

| Vía de la alerta | RNC | Km | ID_KM | ID_RED | Coordenadas | Entidad comprobada |
| --- | --- | ---: | ---: | ---: | --- | --- |
| Cuernavaca–Acapulco | 95, `PEAJE=Si`, mismo nombre | 142 | 1510 | 1167584 | 18.529994817157206, -99.20052082776984 | Morelos |
| Puente de Ixtla–Iguala | 91, `PEAJE=Si`, mismo nombre | 48 | 1317 | 26107 | 18.402194431886052, -99.48919214593606 | Guerrero |

El km 142 encabeza una cadena de 41 postes consecutivos hasta el 186; los km 143–144 continúan en el mismo tramo a distancias coherentes. El km 48 tiene vecinos 46, 47, 49 y 50 dentro de una cadena de 24 postes del km 24 al 50. En ambos casos `snapM=0` para el poste seleccionado. Una consulta inversa de control devolvió Morelos y Guerrero respectivamente; el worker mantiene la verificación de estado cuando la alerta lo declara. Solo se admite el nombre específico, el km exacto y ausencia de `libre`; el mapa usa un radio aproximado de 1.5 km.

Otros avisos de hoy permanecen pendientes: la RNC nombra `Zacapalco - Taxco` para el km 8, no `Zacapalco - Rancho Viejo`; las cadenas candidatas no bastan para Querétaro–Irapuato km 63 ni Plan de Ayala–El Porvenir km 48. Sánchez Magallanes usa una referencia de caseta aparte, no un km 103.8 validado.

Después del despliegue, `supabase/migrations/20260928_rnc_95d_91d_reviewed_backfill.sql` actualiza únicamente alertas recientes sin coordenadas que coincidan con vía, km y estado compatible. La migración no decide la ubicación de los otros avisos.
