# Colibrí API

Backend de **Colibrí**, app de cultura general con retroalimentación estilo Duolingo.
Expone la REST API (jugadores, progreso, ranking) y el servidor WebSocket de duelos
en tiempo real. La landing pública vive en el repo hermano `colibri-landing`.

## Stack

- **Node.js 20+ / Express 5** — HTTP API
- **PostgreSQL 16** — jugadores, preguntas, eventos de sesión, duelos
- **ws** — duelos 1v1 en tiempo real
- **zod** — validación de payloads · **jsonwebtoken** + **bcryptjs** — auth
- **Docker Compose** — Postgres local

## Puesta en marcha

```bash
# 1. Postgres local
docker compose up -d

# 2. Configuración
cp .env.example .env        # ajusta DATABASE_URL y JWT_SECRET

# 3. Dependencias, esquema y banco de preguntas
npm install
npm run migrate
npm run seed

# 4. Arrancar
npm run dev                 # nodemon, o: npm start
```

El API queda en `http://localhost:4000` y los duelos en `ws://localhost:4000/ws`.

## Scripts

| Comando | Descripción |
| --- | --- |
| `npm start` | Arranca el servidor |
| `npm run dev` | Arranque con recarga (nodemon) |
| `npm run migrate` | Aplica las migraciones de `db/migrations` |
| `npm run seed` | (Re)siembra el banco de preguntas desde los assets de la app |
| `npm test` | Tests de API y duelos (`node --test`) |
| `npm run demo:duel` | Demo end-to-end de un duelo con bots |
| `node scripts/join-duel.js <codigo6> [nombre]` | Únese a una sala como rival (pruebas manuales) |
| `node scripts/smoke-front.js` | Reproduce las llamadas exactas que hace el front Flutter |

## Variables de entorno

| Variable | Descripción | Ejemplo |
| --- | --- | --- |
| `PORT` | Puerto HTTP | `4000` |
| `DATABASE_URL` | Connection string de Postgres | `postgres://user:pass@host:5432/colibri` |
| `JWT_SECRET` | Secreto para firmar tokens | _(obligatorio en producción)_ |
| `CORS_ORIGIN` | Orígenes web permitidos | `*` (dev) o `https://tudominio.com,https://www.tudominio.com` |

### Notas de CORS

- El navegador es el único que aplica CORS: **la app móvil no lo usa**, así que con
  `*` en desarrollo todo funciona igual.
- En producción con web (landing, panel), pon la lista exacta de dominios
  separados por coma; cualquier otro sitio queda bloqueado.
- El WebSocket de duelos (`/ws`) **no** usa CORS: se protege con el token JWT en la
  query string (`?token=...`).

## API

| Método | Ruta | Auth | Descripción |
| --- | --- | --- | --- |
| `GET` | `/api/health` | – | Health check |
| `POST` | `/api/players/guest` | – | Registra/identifica un invitado por `deviceId` |
| `GET` | `/api/players/me` | ✔ | Perfil del jugador autenticado |
| `POST` | `/api/auth/register` | ✔ | Crea cuenta con email y contraseña |
| `POST` | `/api/auth/login` | – | Devuelve token + perfil |
| `POST` | `/api/progress/sync` | ✔ | Sube XP/puntos/racha (monótono, anti-cheat) |
| `DELETE` | `/api/progress` | ✔ | Reinicia el progreso en el servidor |
| `GET` | `/api/leaderboard` | – | Ranking `period=week\|month\|all` |

Autenticación: `Authorization: Bearer <token>`.

### WebSocket `/ws`

Conexión con `?token=<jwt>`. Mensajes del cliente:

| Tipo | Payload | Descripción |
| --- | --- | --- |
| `create` | – | Crea una sala y devuelve el código de 6 dígitos |
| `join` | `code` | Se une a una sala existente |
| `ready` | – | Marca listo; cuando ambos lo están empieza el duelo |
| `answer` | `index`, `option`, `elapsedMs` | Responde una pregunta |
| `leave` | – | Abandona la sala |

Mensajes del servidor: `hello`, `room`, `created`, `start` (preguntas **sin** la
respuesta correcta), `answerAck`, `opponentAnswer`, `result`, `error`.

## Tests

```bash
npm test
```

Usa `test/helpers/bootstrap.js` para levantar un esquema aislado
(`colibri_test`). Requiere el Postgres de `docker-compose` corriendo.

## Estructura

```
├── db/
│   ├── migrations/       # SQL versionado
│   ├── migrate.js        # runner de migraciones
│   └── seed.js           # banco de preguntas
├── scripts/              # demos y herramientas de prueba
├── src/
│   ├── app.js            # express + rutas
│   ├── server.js         # arranque, WS, shutdown
│   ├── controllers/      # auth, progress, leaderboard
│   ├── services/         # ranking, salas de duelo
│   ├── ws/duelServer.js  # duelos en tiempo real
│   ├── middleware/       # auth, validación, errores
│   └── routes/
└── test/
```

## Despliegue

### Vercel (API REST)

La API pública corre en Vercel vía `api/index.js` (exporta la app Express;
`server.js` solo se usa en local con `listen`). `vercel.json` enruta todo a esa
función.

1. Crea el proyecto en Vercel apuntando a este repo (`main`).
2. Env vars del proyecto: `DATABASE_URL` (p. ej. Supabase), `JWT_SECRET`,
   `CORS_ORIGIN=*` o dominios exactos.
3. Deploy. Health check: `https://tu-dominio.vercel.app/api/health`.

> **Duelos:** Vercel serverless **no** soporta WebSocket. `/api/*` funciona en
> la nube; los duelos necesitan un host con WebSocket propio (el `npm start`
> local, un VPS, Render con WebSockets, etc.). La app móvil usa el API REST de
> Vercel y apunta el WebSocket a otro host vía `--dart-define=WS_URL=`.

### Server con WebSocket (duelos)

1. Postgres gestionado (p. ej. Supabase) → copia la connection string a `DATABASE_URL`.
2. Define `JWT_SECRET` fuerte y `CORS_ORIGIN` con el dominio real del front.
3. `npm run migrate && npm run seed` una vez, luego `npm start`.
