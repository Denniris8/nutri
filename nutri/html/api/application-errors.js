async function recordApplicationError({ dbQuery, textSql, userId, traceId, area, event, stage, action, method, route, httpStatus, upstreamHttpStatus, error, description }) {
  const rawCode = error?.code;
  const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,55}$/.test(rawCode)
    ? rawCode
    : Number.isInteger(httpStatus) ? `HTTP_${httpStatus}` : 'APPLICATION_ERROR';
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  const values = [area, traceId, event, stage, action, method, route, userId == null ? null : String(userId), code, name, httpStatus, upstreamHttpStatus, description]
    .map((value) => value == null ? 'NULL' : textSql(String(value)));
  await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,upstream_http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${values.join(',')});`);
}

module.exports = { recordApplicationError };
