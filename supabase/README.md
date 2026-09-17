# Supabase para Zero Vial

## 1. Crear las tablas

En el proyecto `hjymytmsstmhivjdtxso`, abre **SQL Editor**, pega el contenido de `schema.sql` y ejecútalo una sola vez.

El esquema incluye:

- perfiles y planes (`free`, `trial`, `pro`, `company`);
- roles protegidos (`user`, `operator`, `admin`);
- prueba completa inicial de 7 días;
- alertas históricas;
- correcciones de ubicación con revisión;
- preferencias de filtros y horarios;
- suscripciones push;
- estado de salud del worker central;
- políticas RLS para que cada usuario solo pueda consultar y modificar sus propios datos.

## 2. Variables de Vercel

Agrega estas variables al proyecto de Zero Vial:

```text
SUPABASE_URL=https://hjymytmsstmhivjdtxso.supabase.co
SUPABASE_ANON_KEY=<clave pública anon/publishable>
```

`SUPABASE_ANON_KEY` es una clave pública diseñada para el frontend. No agregues aquí `service_role`, secretos JWT ni contraseñas de base de datos.

Después de guardar las variables, crea un nuevo despliegue en Vercel.

## 3. Autorizar el Centro de Operaciones

El acceso administrativo ya no aparece públicamente. Para autorizar una cuenta,
ejecuta desde **SQL Editor**:

```sql
update public.profiles
set role = 'admin'
where id = (select id from auth.users where email = 'TU_CORREO');
```

Usa `operator` para quien sólo revisará y publicará alertas. El rol no puede
modificarse desde el navegador: sólo `display_name` permanece editable por el
propio usuario.

## 4. Autenticación

En **Authentication → URL Configuration**, configura:

```text
Site URL: https://nexu-lilac.vercel.app
Redirect URL: https://nexu-lilac.vercel.app/**
```

Cuando se compre el dominio, reemplaza la URL principal y conserva temporalmente la dirección de Vercel como URL adicional.

## 5. Notificaciones push

La tabla y las preferencias ya quedan preparadas. El envío real se habilitará en una siguiente fase mediante claves VAPID y una función del servidor; no deben enviarse notificaciones hasta validar la precisión geográfica.

## 6. Worker central

El proceso de vigilancia vive en `worker/index.js` y debe ejecutarse en un
servicio persistente, no dentro del navegador. Para Render se incluye
`render.yaml`.

Variables obligatorias del worker:

```text
SUPABASE_URL=https://hjymytmsstmhivjdtxso.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<clave secreta; sólo en el worker>
GROQ_API_KEY=<clave de Groq>
```

También acepta `GOOGLE_MAPS_API_KEY`, `RSS_PRI`, `RSS_SEC`,
`WORKER_INTERVAL_MS`, `ALERT_MAX_AGE_HOURS` y `MAX_AI_PER_CYCLE`.

La clave `SUPABASE_SERVICE_ROLE_KEY` nunca debe agregarse a `index.html`,
Vercel público ni un repositorio. El frontend sólo utiliza la clave publishable.
