# Zero Vial · Nexu

Zero Vial es una plataforma de alertas viales en tiempo real para México. Agrega feeds RSS de incidentes viales, los clasifica y enriquece con IA, los geolocaliza y los visualiza en un mapa interactivo.

## Características

- **Agregación de feeds RSS**: Obtiene incidentes de [Google News](https://news.google.com/) y [RSS.app](https://rss.app/), con filtrado específico para México y eventos viales.
- **Clasificación con IA**: Utiliza modelos LLM a través de [Groq](https://groq.com/) para validar, clasificar y enriquecer alertas viales.
- **Geocodificación inteligente**: Prioriza proveedores (`Geoapify`, `Google Maps`, `Nominatim`) con snapping a carreteras para mejorar la precisión de ubicaciones.
- **Emparejamiento vial**: Lógica robusta para normalizar nombres de carreteras, códigos de ruta (ej. 57, 57D) y evitar falsos positivos entre corredores paralelos.
- **Procesamiento por worker**: Worker dedicado para deduplicar, enriquecer y puntuar alertas de forma periódica.
- **Mapa interactivo**: Interfaz web con [Leaflet](https://leafletjs.com/) para visualizar alertas, red vial y casetas de peaje.
- **Listo para serverless**: Compatible con [Vercel](https://vercel.com/) y [Render](https://render.com/).

## Requisitos

- [Node.js](https://nodejs.org/) >= 20
- Clave de API de [Groq](https://console.groq.com/keys)
- (Opcional) Clave de [Google Maps Platform](https://console.cloud.google.com/google/maps-apis/) para mejorar geocodificación/snapping
- (Opcional) Clave de [Geoapify](https://www.geoapify.com/) como proveedor principal de geocodificación
- (Opcional) Proyecto en [Supabase](https://supabase.com/) para persistencia de datos

## Instalación

```bash
# Clonar repositorio
git clone https://github.com/karlossxt/nexu.git
cd nexu

# No requiere instalación de dependencias (usa Node.js nativo)
# Verifica que todo funciona
node --check server.js
node --check worker/index.js
```

## Configuración de variables de entorno

### Desarrollo local (.env)

Copia `.env.example` a `.env` para desarrollo local:

```bash
cp .env.example .env
```

Edita `.env` con tus credenciales.

### Vercel (Production/Preview)

En Vercel ve a **Project Settings → Environment Variables**. Allí puedes añadir todas las variables.

**Regla de oro:** Las variables **solo del servidor** (claves, tokens) deben marcarse como **Secret**. Las variables que el frontend necesita leer **no deben** contener información sensible.

| Variable | Tipo recomendado en Vercel | Servidor/Cliente | Descripción |
|---|---|---|---|
| `GROQ_API_KEY` | **Secret** | Solo servidor | Clave API de Groq para el proxy `/api/groq` |
| `APP_TOKEN` | **Secret** | Solo servidor | Token para proteger `/api/groq`. El navegador debe enviarlo en `x-app-token`. |
| `GOOGLE_MAPS_API_KEY` | **Secret** | Solo servidor | Mejora geocodificación y snapping a carreteras |
| `GEOAPIFY_API_KEY` | **Secret** | Solo servidor | Proveedor preferente para búsqueda/reverse geocoding |
| `RSS_PRI` | **Secret** | Solo servidor | Feed RSS privado (RSS.app). **Nunca** se expone al navegador por defecto |
| `RSS_SEC` | Plain/Variable | Solo servidor (o expuesta si necesario) | Feed RSS secundario. Si está vacío usa Google News México |
| `EXPOSE_RSS_PRI` | Plain/Variable | Solo servidor | `1` para exponer `RSS_PRI` al frontend vía `/api/config` (úsalo solo si es un feed no sensible) |
| `GROQ_MODEL` | Plain/Variable | Servidor + expuesta | Modelo por defecto para clasificación (por defecto `openai/gpt-oss-20b`) |
| `REPORT_MODEL` | Plain/Variable | Servidor + expuesta | Modelo para reportes (por defecto `openai/gpt-oss-120b`) |
| `SUPABASE_URL` | Plain/Variable | Servidor + expuesta | URL de proyecto Supabase (no sensible) |
| `SUPABASE_ANON_KEY` | **Plain/Variable (NO Secret)** | Expuesta al cliente | Anon key pública de Supabase. Está pensada para enviarse al navegador (requiere **RLS** correctamente configurado). **Nunca uses Service Role Key aquí.** |
| `TRUST_PROXY` | Plain/Variable | Solo servidor | `1` para confiar en `X-Forwarded-For` (se activa automáticamente en Vercel/Render) |
| `TRUSTED_PROXY_HOPS` | Plain/Variable | Solo servidor | Número de hops de proxy confiables (por defecto `1`) |
| `NODE_ENV` | Plain/Variable | Solo servidor | `production` activa validaciones más estrictas |
| `EXTRA_PUBLIC_FILES` | Plain/Variable | Solo servidor | Archivos extra separados por coma para servir como estáticos |

> **Nota importante:** Las variables marcadas como **Secret** en Vercel **se inyectan como `process.env`** en tiempo de ejecución. El código no necesita ningún cambio para leerlas. Esta distinción sirve para evitar que aparezcan en logs, no para cambiar su disponibilidad en funciones Node.js.

> **Seguridad en producción:** Cuando `NODE_ENV=production`, `VERCEL` o `RENDER` están presentes, **es obligatorio** configurar `APP_TOKEN`. Sin él, el servidor rechazará las llamadas a `/api/groq`.

## Ejecución

### Desarrollo local (servidor completo)

```bash
npm start
# o
node server.js
```

El servidor estará disponible en [http://localhost:3000](http://localhost:3000).

### Worker (procesamiento de alertas)

```bash
# Ejecuta el worker en bucle
npm run worker

# Ejecuta una sola iteración (útil para debugging)
npm run worker:once
```

### Validación de sintaxis

```bash
npm run check
```

## Tests

El proyecto utiliza el test runner nativo de Node.js (`node --test`).

```bash
# Ejecutar todos los tests
node --test

# Ejecutar tests específicos
node --test lib/alert-km.test.js
node --test worker/*.test.js
node --test tools/test_rnc_national_review.js
```

**Estado actual:** Todos los tests pasan (tests de núcleo + herramientas). La lógica crítica (parseo de kilómetros, matching de carreteras/corredores, procesamiento RNC) está fuertemente testeada.

## Arquitectura

```text
zero/
├── api/                # Endpoints serverless (Vercel/Render)
│   ├── feed.js         # Proxy + filtrado de feeds RSS
│   └── geocode.js      # Geocodificación con múltiple proveedor + snapping
├── lib/                # Lógica compartida (reutilizada entre server, api, worker)
│   ├── alert-km.js     # Extracción/validación de kilómetros
│   ├── corridor-reference.js
│   ├── road-match.js   # Normalización y matching de carreteras
│   ├── state-match.js  # Normalización y matching de estados
│   └── *.test.js       # Tests unitarios
├── worker/             # Worker de procesamiento de alertas
│   ├── index.js        # Lógica principal del worker
│   ├── red-vial.js     # Dataset de red vial (generado)
│   └── *.test.js       # Tests del worker
├── tools/              # Utilidades y scripts de procesamiento de datos
├── supabase/           # Esquema y migraciones de BD
├── server.js           # Servidor HTTP local + API routes
├── index.html          # Frontend (SPA)
└── vercel.json         # Configuración de despliegue Vercel
```

### Endpoints API

| Endpoint | Método | Auth | Descripción |
|---|---|---|---|
| `/api/groq` | GET/POST | Requiere `x-app-token` (si `APP_TOKEN` configurado) | Proxy seguro a Groq Chat Completions. GET con `action=models` devuelve modelos permitidos |
| `/api/config` | GET | Pública | Configuración pública para frontend (feeds RSS, modelos, Supabase). `RSS_PRI` solo se expone si `EXPOSE_RSS_PRI=1` |
| `/api/feed` | GET | Pública (con rate limit) | Obtiene y limpia feeds RSS (`?url=`). Solo hosts autorizados (`rss.app`, `news.google.com`). Filtra por relevancia vial/México |
| `/api/geocode` | GET | Pública (con rate limit) | Geocodificación con fallback multi-proveedor. Parámetros: `q`, `mode` (search/autocomplete/reverse), `lat/lon`, `state`, `road`, `snap`, `check` |

## Despliegue

### Vercel

El proyecto incluye `vercel.json`. Solo necesitas configurar las variables de entorno en el dashboard de Vercel:

1. Importa el repo en Vercel
2. Ve a **Settings → Environment Variables** y añade las variables (usa **Secret** para claves/tokens servidor)
3. Asigna los entornos deseados (Production/Preview/Development)
4. Deploy automático con cada push

### Render

Incluye `render.yaml`. Configura el servicio web y variables de entorno correspondientes.

## Seguridad

- **Protección SSRF**: `api/feed.js` solo acepta hosts HTTPS autorizados (`rss.app`, `news.google.com`).
- **Rate limiting**: Límites por IP con limpieza automática para evitar agotamiento de memoria.
- **Timing-safe comparison**: Comparación de tokens a tiempo constante para prevenir ataques de temporización.
- **Validación estricta**: Sanitización de payloads, límites de tamaño, roles/modelos permitidos.
- **Headers de seguridad**: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, HSTS (en HTTPS).
- **Supabase RLS**: Si usas Supabase, **habilita obligatoriamente Row Level Security (RLS)** en las tablas y define políticas adecuadas. Usa únicamente la `anonKey` (nunca Service Role Key) en el cliente.

## Contribución

1. Haz fork del repositorio
2. Crea una rama para tu feature (`git checkout -b feature/nombre`)
3. Asegúrate de que los tests pasan (`node --test`)
4. Verifica sintaxis (`npm run check`)
5. Envía un Pull Request

## Licencia

[MIT](LICENSE)

## Notas

- La lógica de matching vial está optimizada para nomenclatura y códigos de carretera mexicanos.
- Los datasets estáticos (`red-vial.js`, `casetas-data.js`) son generados offline. No se reconstruyen en tiempo de ejecución.
- Para evitar falsos positivos entre rutas paralelas, el sistema prioriza coincidencia por código de ruta + tokens nominales + estado/corredor.