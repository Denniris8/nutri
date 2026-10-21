const categories = new Set(['comida', 'entrenamiento', 'plan']);
const states = new Set(['requiere_respuesta', 'guardado', 'generado', 'error', 'resuelta']);

function notificationInsertSql({ userId, category, state, title, message, referenceId = null, textSql }) {
  if (!/^[1-9]\d{0,19}$/.test(String(userId)) || !categories.has(category) || !states.has(state)
    || typeof title !== 'string' || typeof message !== 'string'
    || referenceId != null && !/^[1-9]\d{0,19}$/.test(String(referenceId))) throw new Error('notification_invalid');
  const values = [category, state, title.slice(0, 120), message.slice(0, 2000), referenceId];
  return `INSERT INTO notificaciones_usuario(usuario_id,categoria,estado,titulo,mensaje,referencia_id,creado_en) VALUES (${userId},${textSql(values[0])},${textSql(values[1])},${textSql(values[2])},${textSql(values[3])},${values[4] == null ? 'NULL' : textSql(String(values[4]))},UTC_TIMESTAMP(3))`;
}

async function addNotification(options) {
  await options.dbQuery(`${notificationInsertSql(options)};`);
}

function resolveNotificationsSql({ userId, category, state = 'requiere_respuesta', textSql }) {
  if (!/^[1-9]\d{0,19}$/.test(String(userId)) || !categories.has(category) || !states.has(state)) throw new Error('notification_invalid');
  return `UPDATE notificaciones_usuario SET estado='resuelta',leida_en=COALESCE(leida_en,UTC_TIMESTAMP(3)) WHERE usuario_id=${userId} AND BINARY categoria=BINARY ${textSql(category)} AND BINARY estado=BINARY ${textSql(state)}`;
}

async function readNotifications({ userId, dbQuery }) {
  const [rows, unreadCount] = await Promise.all([
    dbQuery(`SELECT JSON_OBJECT('id',CAST(id AS CHAR),'category',categoria,'state',estado,'title',titulo,'message',mensaje,'referenceId',CAST(referencia_id AS CHAR),'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ'),'readAt',IF(leida_en IS NULL,NULL,DATE_FORMAT(leida_en,'%Y-%m-%dT%H:%i:%sZ'))) FROM notificaciones_usuario WHERE usuario_id=${userId} ORDER BY creado_en DESC,id DESC LIMIT 50;`),
    dbQuery(`SELECT COUNT(*) FROM notificaciones_usuario WHERE usuario_id=${userId} AND leida_en IS NULL;`),
  ]);
  return {
    notifications: rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [],
    unreadCount: Number(unreadCount) || 0,
  };
}

async function markNotificationRead({ userId, notificationId, dbQuery }) {
  if (!/^\d+$/.test(String(userId)) || !/^[1-9]\d{0,19}$/.test(String(notificationId))) return false;
  return Number((await dbQuery(`UPDATE notificaciones_usuario SET leida_en=COALESCE(leida_en,UTC_TIMESTAMP(3)) WHERE id=${notificationId} AND usuario_id=${userId}; SELECT COUNT(*) FROM notificaciones_usuario WHERE id=${notificationId} AND usuario_id=${userId};`)).split(/\s+/).at(-1)) === 1;
}

module.exports = { addNotification, markNotificationRead, notificationInsertSql, readNotifications, resolveNotificationsSql };
