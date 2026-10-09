function notFound(req, res) {
  res.status(404).json({ error: 'Ruta no encontrada' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON inválido' });
  }
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'Error interno' });
}

module.exports = { notFound, errorHandler };
