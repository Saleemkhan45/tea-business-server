export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source])
    if (!result.success) {
      return res.status(400).json({
        message: 'Validation failed.',
        issues: result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })),
      })
    }

    Object.defineProperty(req, source, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: result.data,
    })
    next()
  }
}
