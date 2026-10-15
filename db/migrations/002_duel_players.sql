-- Multijugador hasta 8 jugadores: historial de participantes por duelo
CREATE TABLE IF NOT EXISTS duel_players (
  duel_id   uuid NOT NULL REFERENCES duels(id) ON DELETE CASCADE,
  player_id uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  position  int  NOT NULL DEFAULT 0,
  correct   int  NOT NULL DEFAULT 0,
  total_ms  int  NOT NULL DEFAULT 0,
  is_winner boolean NOT NULL DEFAULT false,
  connected boolean NOT NULL DEFAULT true,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (duel_id, player_id)
);

CREATE INDEX IF NOT EXISTS duel_players_duel_position_idx
  ON duel_players (duel_id, position);

-- Las columnas de 2 jugadores quedan legacy (nadie las lee); se permiten NULL
-- para no falsear marcadores con salas de más de 2 participantes.
ALTER TABLE duels ALTER COLUMN host_score DROP NOT NULL;
ALTER TABLE duels ALTER COLUMN guest_score DROP NOT NULL;
ALTER TABLE duels ADD COLUMN IF NOT EXISTS max_players smallint NOT NULL DEFAULT 8;
