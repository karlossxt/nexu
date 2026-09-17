# Supabase para Zero Vial

## 1. Crear las tablas

En el proyecto `hjymytmsstmhivjdtxso`, abre **SQL Editor**, pega el contenido de `schema.sql` y ejecútalo una sola vez.

El esquema incluye:

- perfiles y planes (`free`, `trial`, `pro`, `company`);
- prueba completa inicial de 7 días;
- alertas históricas;
- correcciones de ubicación con revisión;
- preferencias de filtros y horarios;
- suscripciones push;
- políticas RLS para que cada usuario solo pueda consultar y modificar sus propios datos.

## 2. Variables de Vercel

Agrega estas variables al proyecto de Zero Vial:

```text
SUPABASE_URL=https://hjymytmsstmhivjdtxso.supabase.co
SUPABASE_ANON_KEY=<clave pública anon/publishable>
```

`SUPABASE_ANON_KEY` es una clave pública diseñada para el frontend. No agregues aquí `service_role`, secretos JWT ni contraseñas de base de datos.

Después de guardar las variables, crea un nuevo despliegue en Vercel.

## 3. Autenticación

En **Authentication → URL Configuration**, configura:

```text
Site URL: https://nexu-lilac.vercel.app
Redirect URL: https://nexu-lilac.vercel.app/**
```

Cuando se compre el dominio, reemplaza la URL principal y conserva temporalmente la dirección de Vercel como URL adicional.

## 4. Notificaciones push

La tabla y las preferencias ya quedan preparadas. El envío real se habilitará en una siguiente fase mediante claves VAPID y una función del servidor; no deben enviarse notificaciones hasta validar la precisión geográfica.
