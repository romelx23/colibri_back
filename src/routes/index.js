const express = require('express');
const { validate } = require('../middleware/validate');
const { authRequired } = require('../middleware/auth');
const authController = require('../controllers/authController');
const progressController = require('../controllers/progressController');
const leaderboardController = require('../controllers/leaderboardController');
const examController = require('../controllers/examController');

const router = express.Router();

router.post(
  '/players/guest',
  validate(authController.schemas.guestSchema),
  authController.guest
);
router.get('/players/me', authRequired, authController.me);
router.put(
  '/players/me',
  authRequired,
  validate(authController.schemas.updateMeSchema),
  authController.update
);
router.post(
  '/auth/register',
  authRequired,
  validate(authController.schemas.registerSchema),
  authController.register
);
router.post(
  '/auth/login',
  validate(authController.schemas.loginSchema),
  authController.login
);
router.post(
  '/progress/sync',
  authRequired,
  validate(progressController.syncSchema),
  progressController.sync
);
router.delete('/progress', authRequired, progressController.reset);
router.post(
  '/exams/submit',
  authRequired,
  validate(examController.submitSchema),
  examController.submit
);
router.get('/leaderboard', leaderboardController.list);

module.exports = router;
