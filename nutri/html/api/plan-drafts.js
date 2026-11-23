const conflict = () => Object.assign(new Error('El borrador cambió, venció o ya no está disponible.'), { status: 409 });

function planDraftStore(userId, runId, dbQuery, textSql) {
  if (!/^\d+$/.test(String(userId)) || typeof runId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)) {
    throw Object.assign(new Error('Identificador del borrador no válido.'), { status: 400 });
  }
  const key = `usuario_id=${userId} AND run_id=${textSql(runId)}`;
  const alive = `${key} AND vence_en>UTC_TIMESTAMP(3)`;
  const create = (state) => `INSERT INTO borradores_plan(usuario_id,run_id,estado,vence_en) VALUES (${userId},${textSql(runId)},'${state}',UTC_TIMESTAMP(3)+INTERVAL 24 HOUR)`;
  const read = async () => {
    const row = await dbQuery(`SELECT JSON_OBJECT('revision',revision,'state',estado,'data',datos,'expiresAt',TIMESTAMPDIFF(MICROSECOND,'1970-01-01',vence_en) DIV 1000) FROM borradores_plan WHERE ${alive};`);
    if (!row) throw conflict();
    return JSON.parse(row);
  };
  const revisionNumber = (rev) => {
    if (!Number.isSafeInteger(rev) || rev < 0) throw conflict();
    return rev;
  };
  return {
    async importLegacy(data, expiresAt) {
      await dbQuery(`INSERT INTO borradores_plan(usuario_id,run_id,revision,estado,datos,vence_en) VALUES (${userId},${textSql(runId)},1,'abierto',${textSql(JSON.stringify(data))},${textSql(new Date(expiresAt).toISOString().slice(0,23).replace('T',' '))}) ON DUPLICATE KEY UPDATE run_id=run_id;`);
    },
    async begin() {
      await dbQuery(`DELETE FROM borradores_plan WHERE vence_en<=UTC_TIMESTAMP(3); ${create('generando')} ON DUPLICATE KEY UPDATE run_id=run_id;`);
      if ((await read()).state !== 'generando') throw conflict();
    },
    async current() {
      const row = await read();
      if (row.state !== 'abierto') throw conflict();
      return { ...row.data, revision: row.revision, expiresAt: row.expiresAt, runId };
    },
    async publish(rev, data) {
      const changed = await dbQuery(`UPDATE borradores_plan SET datos=${textSql(JSON.stringify(data))},revision=revision+1,estado='abierto' WHERE ${alive} AND revision=${revisionNumber(rev)} AND estado='${rev ? 'abierto' : 'generando'}'; SELECT ROW_COUNT();`);
      if (changed.trim() !== '1') throw conflict();
    },
    async claim(rev) {
      await dbQuery(`UPDATE borradores_plan SET estado='guardando' WHERE ${alive} AND revision=${revisionNumber(rev)} AND estado='abierto' AND JSON_EXTRACT(datos,'$.question') IS NULL;`);
      const row = await read();
      if (row.revision !== rev || !['guardando','guardado'].includes(row.state)) throw conflict();
      return row;
    },
    async finish(rev, saved) {
      await dbQuery(`UPDATE borradores_plan SET estado='guardado',datos=${textSql(JSON.stringify({ ...saved, inserted: false }))} WHERE ${key} AND revision=${revisionNumber(rev)} AND estado='guardando';`);
    },
    async cancel(rev) {
      // A cancellation can arrive before generation has created its row.
      await dbQuery(`${create('cancelado')} ON DUPLICATE KEY UPDATE run_id=run_id; UPDATE borradores_plan SET estado='cancelado',datos=NULL WHERE ${alive} AND estado IN ('abierto','generando') AND ${rev === 0 ? 'revision IN (0,1)' : `revision=${revisionNumber(rev)}`};`);
      const row = await read();
      if (row.state !== 'cancelado') throw conflict();
    },
  };
}

function visiblePlan({ runId, revision, plan, goals, macros, question, expiresAt }) {
  const common = { runId, revision, goals, expiresAt };
  return question ? { ...common, state: 'requiere_aclaracion', question } : { ...common, state: 'plan_listo', plan, macros };
}

module.exports = { planDraftStore, visiblePlan };
