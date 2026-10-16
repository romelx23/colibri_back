const { z } = require('zod');
const { withTransaction, query } = require('../config/db');
const { scoreExam } = require('../services/examScoring');

const submitSchema = z.object({
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1).max(64),
        // -1 = en blanco; si no viene, también cuenta como en blanco
        answerIndex: z.number().int().min(-1).max(6).optional(),
        elapsedMs: z.number().int().min(0).max(3600000).optional(),
      })
    )
    .min(1)
    .max(100),
  cutoff: z.number().int().min(0).max(100).optional(),
});

exports.submitSchema = submitSchema;

// POST /api/exams/submit — calcula el puntaje del examen en el servidor,
// registra el evento (kind='exam') y actualiza el mejor puntaje histórico.
exports.submit = async (req, res, next) => {
  try {
    const playerId = req.player.id;
    const { answers, cutoff = 70 } = req.body;
    const questionIds = [...new Set(answers.map((a) => a.questionId))];

    const { rows } = await query(
      `SELECT id, categoria, dificultad, fuente, correcta
         FROM questions
        WHERE id = ANY($1::text[])`,
      [questionIds]
    );
    if (rows.length !== questionIds.length) {
      return res.status(422).json({ error: 'Algunas preguntas no existen' });
    }

    const questionMap = new Map(rows.map((r) => [r.id, r]));
    const result = scoreExam(questionMap, answers, cutoff);

    const player = await withTransaction(async (client) => {
      // exam_best es la métrica del ranking histórico: solo puede subir.
      const updated = await client.query(
        `UPDATE players
            SET exam_best = GREATEST(exam_best, $2), updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [playerId, result.score]
      );

      await client.query(
        `INSERT INTO session_events (player_id, kind, points_delta, payload)
         VALUES ($1, 'exam', $2, $3)`,
        [
          playerId,
          result.score,
          JSON.stringify({
            correct: result.correct,
            total: result.total,
            percent: result.percent,
            cutoff,
            passed: result.passed,
          }),
        ]
      );
      return updated.rows[0];
    });

    res.status(201).json({
      ...result,
      examBest: player.exam_best,
    });
  } catch (err) {
    next(err);
  }
};
