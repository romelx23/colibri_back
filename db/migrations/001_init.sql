-- Colibrí API - esquema inicial
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Banco de preguntas (seed desde assets de la app)
CREATE TABLE IF NOT EXISTS questions (
  id          text PRIMARY KEY,
  categoria   text NOT NULL,
  tema        text NOT NULL DEFAULT '',
  fuente      text NOT NULL DEFAULT '',
  dificultad  text NOT NULL DEFAULT 'intermedio',
  enunciado   text NOT NULL,
  opciones    jsonb NOT NULL,
  correcta    int  NOT NULL CHECK (correcta >= 0),
  explicacion text NOT NULL DEFAULT '',
  analisis    jsonb NOT NULL DEFAULT '[]'::jsonb,
  referencia  text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS questions_categoria_idx ON questions (categoria);

-- Jugadores
CREATE TABLE IF NOT EXISTS players (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     text NOT NULL UNIQUE,
  display_name  text NOT NULL,
  avatar_seed   int  NOT NULL DEFAULT 0,
  is_guest      boolean NOT NULL DEFAULT true,
  email         text UNIQUE,
  password_hash text,
  xp            int NOT NULL DEFAULT 0,
  points        int NOT NULL DEFAULT 0,
  streak        int NOT NULL DEFAULT 0,
  best_streak   int NOT NULL DEFAULT 0,
  sessions      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS players_xp_idx ON players (xp DESC);

-- Eventos de sesión: base del ranking por ventana y auditoría
CREATE TABLE IF NOT EXISTS session_events (
  id           bigserial PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'session',
  xp_delta     int  NOT NULL DEFAULT 0,
  points_delta int  NOT NULL DEFAULT 0,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS session_events_player_created_idx
  ON session_events (player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_events_created_idx
  ON session_events (created_at DESC);

-- Duelos en tiempo real
CREATE TABLE IF NOT EXISTS duels (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,
  host_id     uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  guest_id    uuid REFERENCES players(id) ON DELETE SET NULL,
  status      text NOT NULL DEFAULT 'waiting',
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,
  host_score  int NOT NULL DEFAULT 0,
  guest_score int NOT NULL DEFAULT 0,
  winner_id   uuid REFERENCES players(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS duels_code_idx ON duels (code);

CREATE TABLE IF NOT EXISTS duel_answers (
  id         bigserial PRIMARY KEY,
  duel_id    uuid NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  player_id  uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  q_index    int  NOT NULL,
  answer     int  NOT NULL,
  is_correct boolean NOT NULL,
  elapsed_ms int  NOT NULL DEFAULT 0,
  UNIQUE (duel_id, player_id, q_index)
);
