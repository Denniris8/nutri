function createAnalysisProgressRecorder({ dbQuery, textSql, userId, flow, operationId, now = Date.now }) {
  const startedAt = now();
  let previousAt = startedAt;
  let writes = Promise.resolve();

  return {
    record(event) {
      if (!/^[a-z][a-z0-9_]{0,59}$/.test(event || '')) return;
      const occurredAt = now();
      const durationMs = Math.max(0, occurredAt - previousAt);
      const elapsedMs = Math.max(0, occurredAt - startedAt);
      previousAt = occurredAt;
      const values = [flow, operationId, event].map((value) => textSql(String(value)));
      writes = writes.then(() => dbQuery(
        `INSERT INTO analisis_progreso_eventos(usuario_id,flujo,operacion_id,evento,ocurrido_en,duracion_ms,transcurrido_ms) VALUES (${userId},${values.join(',')},UTC_TIMESTAMP(3),${durationMs},${elapsedMs});`,
      )).catch(() => console.error(JSON.stringify({ area: 'analysis-progress', event: 'database_write_failed', operation_id: operationId })));
    },
    flush() { return writes; },
  };
}

module.exports = { createAnalysisProgressRecorder };
