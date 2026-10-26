const allowedPatterns = new Set(['omnivoro', 'vegetariano', 'vegano', 'pescetariano', 'otro', 'sin_preferencia']);
const { decryptGarminCredentials, encryptGarminCredentials, verifyGarminProof } = require('./integration-credentials.js');
const allowedText = (value, limit) => {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > limit) throw new Error('invalid_text');
  return value.trim();
};

async function savePreferences({ request, response, data, userId, dbQuery, textSql, json, secret }) {
  const pattern = data.patronAlimentario;
  const timezone = request.headers['x-client-timezone'];
  const device = data.deviceMode;
  const allergyStatus = data.allergiesStatus;
  const medicationStatus = data.medicationsStatus;
  if (!allowedPatterns.has(pattern) || !['ninguno', 'garmin'].includes(device)
      || !['ninguna_conocida', 'registradas', 'sin_informacion'].includes(allergyStatus)
      || !['ninguno', 'registrados', 'sin_informacion'].includes(medicationStatus)
      || typeof timezone !== 'string' || timezone.length > 64 || !/^\d+$/.test(String(userId))) {
    json(response, 400, { error: 'Completa las preferencias requeridas.' });
    return;
  }
  let credentialSql = '';
  if (device === 'garmin') {
    const email = typeof data.garminEmail === 'string' ? data.garminEmail.trim() : '';
    const password = typeof data.garminPassword === 'string' ? data.garminPassword : '';
    if (email || password || data.garminProof || data.garminCredentialsModified === true) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length > 256
          || !verifyGarminProof({ proof: data.garminProof, email, password, userId, secret })) {
        json(response, 400, { error: 'Vuelve a probar la cuenta Garmin antes de guardarla.' });
        return;
      }
      const encrypted = encryptGarminCredentials(email, password, secret);
      credentialSql = `\nINSERT INTO credenciales_integracion_usuario(usuario_id,proveedor,ciphertext,nonce,auth_tag,key_version) VALUES (${userId},'garmin',UNHEX('${encrypted.ciphertext}'),UNHEX('${encrypted.nonce}'),UNHEX('${encrypted.authTag}'),1) AS incoming ON DUPLICATE KEY UPDATE ciphertext=incoming.ciphertext,nonce=incoming.nonce,auth_tag=incoming.auth_tag,key_version=incoming.key_version;`;
    } else {
      let saved;
      try { saved = await dbQuery(`SELECT EXISTS(SELECT 1 FROM credenciales_integracion_usuario WHERE usuario_id=${userId} AND proveedor='garmin');`); }
      catch { json(response, 503, { error: 'No se pudo comprobar la cuenta Garmin guardada.' }); return; }
      if (saved !== '1') {
        json(response, 400, { error: 'Prueba y confirma tu cuenta Garmin antes de continuar.' });
        return;
      }
    }
  }
  let preferredFoods;
  let avoidedFoods;
  let allergyDetails;
  let medicationDetails;
  try {
    preferredFoods = allowedText(data.preferredFoods, 800);
    avoidedFoods = allowedText(data.avoidedFoods, 800);
    allergyDetails = allowedText(data.allergiesDetails, 2000);
    medicationDetails = allowedText(data.medicationsDetails, 3000);
  } catch {
    json(response, 400, { error: 'El texto de una preferencia excede el límite permitido.' });
    return;
  }
  if ((allergyStatus === 'registradas' && !allergyDetails) || (medicationStatus === 'registrados' && !medicationDetails)) {
    json(response, 400, { error: 'Completa el detalle solicitado.' });
    return;
  }
  if (allergyStatus !== 'registradas') allergyDetails = '';
  if (medicationStatus !== 'registrados') medicationDetails = '';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    json(response, 400, { error: 'Zona horaria no válida.' });
    return;
  }

  try {
    await dbQuery(`START TRANSACTION;
INSERT INTO preferencias_usuario(usuario_id,modo_dispositivo,patron_alimentario,zona_horaria,alimentos_preferidos,alimentos_evitar) VALUES (${userId},${textSql(device)},${textSql(pattern)},${textSql(timezone)},${preferredFoods ? textSql(preferredFoods) : 'NULL'},${avoidedFoods ? textSql(avoidedFoods) : 'NULL'}) AS incoming ON DUPLICATE KEY UPDATE modo_dispositivo=incoming.modo_dispositivo,patron_alimentario=incoming.patron_alimentario,zona_horaria=incoming.zona_horaria,alimentos_preferidos=incoming.alimentos_preferidos,alimentos_evitar=incoming.alimentos_evitar;
INSERT INTO perfil_salud_usuario(usuario_id,estado_alergias,alergias_detalle,estado_medicamentos,medicamentos_detalle) VALUES (${userId},${textSql(allergyStatus)},${allergyDetails ? textSql(allergyDetails) : 'NULL'},${textSql(medicationStatus)},${medicationDetails ? textSql(medicationDetails) : 'NULL'}) AS incoming ON DUPLICATE KEY UPDATE estado_alergias=incoming.estado_alergias,alergias_detalle=incoming.alergias_detalle,estado_medicamentos=incoming.estado_medicamentos,medicamentos_detalle=incoming.medicamentos_detalle;
${credentialSql}
COMMIT;`);
    json(response, 200, { ok: true });
  } catch {
    json(response, 503, { error: 'No se pudieron guardar las preferencias.' });
  }
}

function preferencesSql(userId) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw new Error('invalid_user_id');
  return `SELECT JSON_OBJECT('deviceMode',p.modo_dispositivo,'patronAlimentario',p.patron_alimentario,'timezone',p.zona_horaria,'preferredFoods',p.alimentos_preferidos,'avoidedFoods',p.alimentos_evitar,'allergiesStatus',h.estado_alergias,'allergiesDetails',h.alergias_detalle,'medicationsStatus',h.estado_medicamentos,'medicationsDetails',h.medicamentos_detalle,'garminConnected',EXISTS(SELECT 1 FROM credenciales_integracion_usuario c WHERE c.usuario_id=p.usuario_id AND c.proveedor=\'garmin\')) FROM preferencias_usuario p JOIN perfil_salud_usuario h ON h.usuario_id=p.usuario_id WHERE p.usuario_id=${id} LIMIT 1;`;
}

async function readPreferences({ userId, dbQuery }) {
  const raw = await dbQuery(preferencesSql(userId));
  return raw ? JSON.parse(raw) : null;
}

async function readGarminEmail({ userId, dbQuery, secret }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw new Error('invalid_user_id');
  const row = await dbQuery(`SELECT HEX(ciphertext),HEX(nonce),HEX(auth_tag),key_version FROM credenciales_integracion_usuario WHERE usuario_id=${id} AND proveedor='garmin' LIMIT 1;`);
  if (!row) return null;
  const [ciphertext, nonce, authTag, keyVersion] = row.split('\t');
  if (keyVersion !== '1') return null;
  try {
    const credentials = decryptGarminCredentials({ ciphertext, nonce, authTag }, secret);
    return typeof credentials.email === 'string' && credentials.email.length <= 254 ? credentials.email : null;
  } catch { return null; }
}

module.exports = { preferencesSql, readGarminEmail, readPreferences, savePreferences };
