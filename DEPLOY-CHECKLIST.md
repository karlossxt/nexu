# Zero Vial · Checklist de despliegue y red vial

## Parte 1 · Desplegar y asegurar (en este orden)

1. **Escanear secretos** (desde la raíz del repo):
   `node scripts/scan-secrets.js`
   Cualquier ❌ CRÍTICO → **rotar la llave** en el proveedor (Groq, Google, Supabase…) y actualizarla en Vercel/Render. Borrar el commit no basta.
2. **Rotar el feed de RSS.app** si `RSS_PRI` estuvo en `.env.example` o en el historial.
3. **Subir los archivos**: `server.js`, `worker/index.js`, `index.html`, y **`logo-mark.webp` a la raíz**.
4. **Variables de entorno**: `NOMINATIM_USER_AGENT="ZeroVial/1.0 (tu-correo-real)"`, `APP_TOKEN`, y NO definir `EXPOSE_RSS_PRI`.
5. **Verificar producción**:
   `node scripts/verify-deploy.js https://www.zero-vial.com.mx --private-rss "<tu URL privada de RSS>"`
   Debe terminar con 0 FALLAS. Si falla por archivos internos y usas Vercel → activar `.vercelignore` y repetir.
6. **Supabase** (primero en una rama/staging): ejecutar `supabase/01-rls-audit.sql`, leer los resultados, luego `supabase/02-rls-hardening.sql`, y repetir la auditoría. Probar en la app: ver alertas como visitante, iniciar sesión, guardar preferencias, enviar una corrección.
7. **Logs del worker** (primeras 24 h): buscar `Estado del pin existente actualizado`, `Feed RSS no disponible` y que `worker_status` siga en `healthy`.

## Parte 2 · Arreglar red-vial.js

1. Reúne **anclas reales** (km conocido + coordenadas): casetas con kilometraje oficial, postes RNC, entronques. Formato en `scripts/anchors.example.json` (los valores del ejemplo son ilustrativos).
2. Diagnóstico y verificación:
   `node scripts/verify-red-vial.js --red-vial ./red-vial.js --anchors ./anchors.json`
3. Revisa `red-vial.report.json`. Solo los corredores ✅ "verificado" quedan con `chainageVerified: true`.
4. Copia el `*.verified.js` generado sobre `red-vial.js` **y** `worker/red-vial.js` (el worker usa formato CommonJS: añade `--format cjs` al generarlo para esa copia).
5. En `index.html`, `red-vial.js` está comentado a propósito. Reactívalo solo cuando haya corredores verificados.
6. Tras desplegar, en los logs del worker busca `Kilómetro resuelto con RED_VIAL` y revisa `anchor_gap_km`.
