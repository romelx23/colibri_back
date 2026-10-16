-- Identidad de jugador: nick elegido + icono de perfil (id de catálogo)
ALTER TABLE players ADD COLUMN IF NOT EXISTS avatar_id text NOT NULL DEFAULT 'chick';

-- Mejor puntaje de examen individual (métrica del ranking global)
ALTER TABLE players ADD COLUMN IF NOT EXISTS exam_best int NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS players_exam_best_idx ON players (exam_best DESC);

-- Apariencia de fila de ranking
CREATE INDEX IF NOT EXISTS players_display_name_lower_idx
  ON players (lower(display_name));
