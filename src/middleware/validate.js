function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({
        campo: i.path.join('.'),
        mensaje: i.message,
      }));
      return res.status(400).json({ error: 'Datos inválidos', issues });
    }
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
