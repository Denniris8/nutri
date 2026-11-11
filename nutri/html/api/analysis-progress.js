function createAnalysisProgressRecorder({ dbQuery, textSql, userId, flow, operationId, now = Date.now }) {
  const startedAt = now();
  let previousAt = startedAt;
  let writes = Promise.resolve();
  const pending = [];
  const flush = () => {
    if (!pending.length) return writes;
    const rows = pending.splice(0);
    writes = writes.then(() => dbQuery(
      `INSERT INTO analisis_progreso_eventos(usuario_id,flujo,operacion_id,evento,ocurrido_en,duracion_ms,transcurrido_ms) VALUES ${rows.join(',')};`,
    )).catch(() => console.error(JSON.stringify({ area: 'analysis-progress', event: 'database_write_failed', operation_id: operationId })));
    return writes;
  };

  return {
    record(event) {
      if (!/^[a-z][a-z0-9_]{0,59}$/.test(event || '')) return;
      const occurredAt = now();
      const durationMs = Math.max(0, occurredAt - previousAt);
      const elapsedMs = Math.max(0, occurredAt - startedAt);
      previousAt = occurredAt;
      const values = [flow, operationId, event].map((value) => textSql(String(value)));
      const occurredUtc = new Date(occurredAt).toISOString().slice(0, 23).replace('T', ' ');
      pending.push(`(${userId},${values.join(',')},${textSql(occurredUtc)},${durationMs},${elapsedMs})`);
      // ponytail: se vacían hasta 20 eventos por lote; un cierre abrupto puede perder el lote aún en memoria.
      if (pending.length >= 20) void flush();
    },
    flush,
  };
}

module.exports = { createAnalysisProgressRecorder };
