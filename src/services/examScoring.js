/**
 * Puntaje de examen estilo admisión: el servidor es quien calcula el puntaje
 * (el cliente solo envía sus respuestas), así el ranking no se infla desde
 * el dispositivo.
 *
 * Fórmula por pregunta acertada:
 *   10 base
 *   + dificultad:  0 (básico) / +5 (intermedio) / +10 (difícil)
 *   + fuente:      +5 (San Marcos, UNI) / +3 (UTP, Católica) / +0 (Colibrí)
 *
 * Preguntas incorrectas o en blanco suman 0 (sin penalización, modelo "UNMSM/UNI").
 */

const DIFF_BONUS = { basico: 0, intermedio: 5, dificil: 10 };
const SOURCE_BONUS = { unmsm: 5, uni: 5, utp: 3, pucp: 3, original: 0 };

function pointsFor(question) {
  return (
    10 +
    (DIFF_BONUS[question.dificultad] ?? 0) +
    (SOURCE_BONUS[question.fuente] ?? 0)
  );
}

/**
 * @param {Map<string, {id, categoria, dificultad, fuente, correcta}>} questionMap
 * @param {Array<{questionId: string, answerIndex: number}>} answers
 * @param {number} cutoff porcentaje de corte (default 70)
 */
function scoreExam(questionMap, answers, cutoff = 70) {
  let score = 0;
  let correct = 0;
  let unanswered = 0;
  const byCategory = {};

  for (const a of answers) {
    const q = questionMap.get(a.questionId);
    if (!q) continue;
    const bucket = (byCategory[q.categoria] ||= { correct: 0, total: 0, score: 0 });
    bucket.total += 1;

    const answered = a.answerIndex >= 0;
    if (!answered) unanswered += 1;
    if (answered && a.answerIndex === q.correcta) {
      const pts = pointsFor(q);
      score += pts;
      correct += 1;
      bucket.correct += 1;
      bucket.score += pts;
    }
  }

  const total = answers.length;
  const percent = total === 0 ? 0 : Math.round((correct / total) * 100);

  return {
    score,
    correct,
    total,
    unanswered,
    percent,
    cutoff,
    passed: total > 0 && percent >= cutoff,
    byCategory,
  };
}

module.exports = { pointsFor, scoreExam, DIFF_BONUS, SOURCE_BONUS };
