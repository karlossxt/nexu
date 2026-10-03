# Worker central de Zero Vial

Este proceso funciona aunque no haya usuarios con la web abierta:

1. consulta los feeds RSS;
2. descarta publicaciones vacías, antiguas o ajenas a México;
3. evita analizar noticias que ya existen en Supabase;
4. clasifica las candidatas con Groq;
5. geocodifica con Google o, como respaldo, OpenStreetMap;
6. guarda las alertas en `public.alerts`;
7. actualiza `public.worker_status`.

## Preparación

1. Ejecuta la versión actual de `supabase/schema.sql`.
2. Crea las variables indicadas en `.env.example` dentro del servicio donde
   se ejecutará el worker.
3. Usa la clave secreta de Supabase sólo en ese servicio.

## Ejecución

```bash
npm run worker
```

Para ejecutar únicamente un ciclo de diagnóstico:

```bash
npm run worker:once
```

## Despliegue

El archivo `render.yaml` permite crear un Background Worker en Render. También
puede usarse el proceso existente de Hugging Face, Railway o un VPS ejecutando
`npm run worker`.

Comprueba la operación con:

```sql
select * from public.worker_status where id = 'main';
select title, source_name, event_at, created_at
from public.alerts
order by created_at desc
limit 20;
```

Un estado `healthy` actualizado hace que la web detenga automáticamente su
monitor local. Si el worker deja de reportar durante diez minutos, el navegador
activa temporalmente el mecanismo anterior como respaldo.
