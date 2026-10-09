require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const QUESTIONS_DIR =
  process.env.QUESTIONS_DIR || path.join(__dirname, '..', '..', 'colibri', 'assets', 'questions');

const COLUMNS = [
  'id',
  'categoria',
  'tema',
  'fuente',
  'dificultad',
  'enunciado',
  'opciones',
  'correcta',
  'explicacion',
  'analisis',
  'referencia',
];

const UPSERT_SQL = `
  INSERT INTO questions (${COLUMNS.join(', ')})
  VALUES (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})
  ON CONFLICT (id) DO UPDATE SET
    categoria = EXCLUDED.categoria,
    tema = EXCLUDED.tema,
    fuente = EXCLUDED.fuente,
    dificultad = EXCLUDED.dificultad,
    enunciado = EXCLUDED.enunciado,
    opciones = EXCLUDED.opciones,
    correcta = EXCLUDED.correcta,
    explicacion = EXCLUDED.explicacion,
    analisis = EXCLUDED.analisis,
    referencia = EXCLUDED.referencia
`;

function loadQuestions() {
  const files = fs.readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith('.json'));
  const items = [];

  for (const file of files) {
    const raw = fs.readFileSync(path.join(QUESTIONS_DIR, file), 'utf8');
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];

    for (const q of list) {
      if (!q.id || !q.enunciado || !Array.isArray(q.opciones)) {
        throw new Error(`pregunta inválida en ${file}: ${JSON.stringify(q).slice(0, 120)}`);
      }
      if (!Number.isInteger(q.correcta) || q.correcta < 0 || q.correcta >= q.opciones.length) {
        throw new Error(`correcta fuera de rango en ${file}: ${q.id}`);
      }
      items.push({
        id: q.id,
        categoria: q.categoria,
        tema: q.tema || '',
        fuente: q.fuente || '',
        dificultad: q.dificultad || 'intermedio',
        enunciado: q.enunciado,
        opciones: JSON.stringify(q.opciones),
        correcta: q.correcta,
        explicacion: q.explicacion || '',
        analisis: JSON.stringify(q.analisis || []),
        referencia: q.referencia || '',
      });
    }
  }
  return items;
}

async function seed(pool) {
  const items = loadQuestions();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const item of items) {
      await client.query(UPSERT_SQL, COLUMNS.map((c) => item[c]));
    }
    const { rows } = await client.query(
      'SELECT categoria, COUNT(*)::int AS n FROM questions GROUP BY categoria ORDER BY categoria'
    );
    await client.query('COMMIT');
    return { total: items.length, byCategory: rows };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seed, loadQuestions, QUESTIONS_DIR };

if (require.main === module) {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  seed(pool)
    .then((res) => {
      console.log(`seed: ${res.total} preguntas`);
      for (const r of res.byCategory) console.log(`  ${r.categoria}: ${r.n}`);
      return pool.end();
    })
    .catch((err) => {
      console.error('error de seed:', err.message);
      process.exit(1);
    });
}
