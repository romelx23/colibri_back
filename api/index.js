// Entrada para Vercel (serverless): se exporta la app Express en lugar de
// llamar a `listen`. El WebSocket de duelos NO corre aquí (ver README).
require('dotenv').config();
const { createApp } = require('../src/app');

module.exports = createApp();
