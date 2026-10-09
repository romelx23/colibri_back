const { getLeaderboard } = require('../services/leaderboard');
const { authOptional } = require('../middleware/auth');

// GET /api/leaderboard?period=week|month|all&limit=50
exports.list = [
  authOptional,
  async (req, res, next) => {
    try {
      const period = String(req.query.period || 'all');
      const limit = req.query.limit || 50;
      const viewerId = req.player ? req.player.id : null;
      const board = await getLeaderboard({ period, limit, viewerId });
      res.json(board);
    } catch (err) {
      next(err);
    }
  },
];
