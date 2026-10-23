const { randomUUID } = require('node:crypto');
const { localDateTimeToUtc, parseFoodTime } = require('./food-entries.js');
const { calendarDayRange, readCalendarTimezone } = require('./calendar-day.js');
const { addNotification, resolveNotificationsSql } = require('./notifications.js');

function parseTrainingSavedTime(description) {
  const time = parseFoodTime(description);
  if (!time) return { status: 'none', value: null };
  if (time.invalid) return { status: 'invalid', value: null };
  if (time.ambiguous || time.hours.length !== 1) return { status: 'ambiguous', value: null };
  return {
    status: 'specified',
    value: `${String(time.hours[0]).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
  };
}

function requestedTrainingTime(description, date, timezone, savedAt) {
  const time = savedAt ? { status: 'specified', value: savedAt } : parseTrainingSavedTime(description);
  if (time.status === 'invalid') throw Object.assign(new Error('La hora indicada no es válida.'), { status: 400 });
  if (time.status === 'ambiguous') throw Object.assign(new Error('Aclara si la hora fue a. m. o p. m., o usa formato de 24 horas.'), { status: 400 });
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) throw Object.assign(new Error('No se pudo detectar la zona horaria del navegador.'), { status: 400 });
  if (time.status === 'none' && !date) return null;
  const now = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const [hour, minute] = (time.status === 'none' ? `${now.hour}:${now.minute}` : time.value).split(':').map(Number);
  const calendarDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const createdAt = localDateTimeToUtc(calendarDate, hour, minute, timezone);
  if (!createdAt) throw Object.assign(new Error('La hora no existe en la fecha seleccionada por el cambio de horario.'), { status: 400 });
  return createdAt;
}

function validateTrainingEntry(data) {
  const description = typeof data.description === 'string' ? data.description.trim() : '';
  const analysis = data.analysis;
  if (!description || description.length > 1200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(description)
    || !analysis || typeof analysis !== 'object' || Array.isArray(analysis)) throw Object.assign(new Error('Revisa la descripción del entrenamiento.'), { status: 400 });
  const activity = typeof analysis.activity === 'string' ? analysis.activity.trim() : '';
  const { durationMinutes, weightKg, met } = analysis;
  const savedAt = data.savedAt == null ? null : data.savedAt;
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';
  if (!activity || activity.length > 120 || /[\u0000-\u001f]/.test(activity)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
    || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440
    || !Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400
    || !Number.isFinite(met) || met <= 0 || met > 30
    || savedAt !== null && (typeof savedAt !== 'string' || !/^\d{2}:\d{2}$/.test(savedAt) || Number(savedAt.slice(0, 2)) > 23 || Number(savedAt.slice(3)) > 59)) throw Object.assign(new Error('El cálculo del entrenamiento está incompleto o la hora no es válida.'), { status: 400 });
  const duration = Number(durationMinutes.toFixed(2));
  const weight = Number(weightKg.toFixed(2));
  const intensity = Number(met.toFixed(2));
  return {
    description, activity, durationMinutes: duration, weightKg: weight, met: intensity, savedAt, requestId,
    caloriesKcal: Math.round(intensity * 3.5 * weight / 200 * duration * 10) / 10,
  };
}

async function recordTrainingError({ dbQuery, textSql, userId, traceId, stage, error, httpStatus, action }) {
  const mysql = String(error?.message || '').match(/\bERROR\s+(\d+)\s+\(([A-Z0-9]{5})\)/);
  const code = mysql ? `MYSQL_${mysql[1]}_${mysql[2]}`
    : typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,55}$/.test(error.code) ? error.code
      : `TRAINING_${stage.toUpperCase()}_FAILED`;
  const name = typeof error?.name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name) ? error.name : 'Error';
  const description = stage === 'analysis' ? 'No se pudo analizar el entrenamiento.'
    : stage === 'verification' ? 'No se pudo verificar el entrenamiento guardado.'
      : stage === 'steps' ? 'No se pudieron guardar los pasos diarios.'
        : stage === 'activation' ? 'No se pudo activar el plan de entrenamiento.' : 'No se pudo guardar el entrenamiento.';
  await dbQuery(`INSERT INTO errores_aplicacion(ocurrido_en,area,trace_id,evento,etapa,accion_realizada,metodo_http,ruta,usuario_id,codigo_error,nombre_error,http_status,descripcion_error) VALUES (UTC_TIMESTAMP(3),${textSql('training-opencode')},${textSql(traceId)},${textSql('training_failed')},${textSql(stage)},${textSql(action)},${textSql('POST')},${textSql(action.split(' ')[1])},${userId},${textSql(code)},${textSql(name)},${httpStatus},${textSql(description)});`);
}

function localCalendarDate(timezone, now = new Date()) {
  let parts;
  try {
    parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).map(({ type, value }) => [type, value]));
  } catch { throw Object.assign(new Error('La zona horaria no es válida.'), { status: 400 }); }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

async function saveDailySteps({ userId, date, localDate, stepsCount, source, dbQuery, textSql }) {
  const parsedDate = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : null;
  if (!/^\d+$/.test(String(userId)) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date
    || date > localDate || !Number.isSafeInteger(stepsCount) || stepsCount < 0 || stepsCount > 250000
    || !['manual', 'garmin'].includes(source)) {
    throw Object.assign(new Error('Los pasos diarios o su fecha no son válidos.'), { status: 400 });
  }
  await dbQuery(`INSERT INTO registros_pasos_diarios(usuario_id,fecha,pasos,fuente,creado_en,actualizado_en) VALUES (${userId},${textSql(date)},${stepsCount},${textSql(source)},UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE pasos=VALUES(pasos),fuente=VALUES(fuente),actualizado_en=UTC_TIMESTAMP(3);`);
  return { date, stepsCount, source };
}

async function readDailySteps({ userId, date, dbQuery, textSql }) {
  const parsedDate = typeof date === 'string' ? new Date(`${date}T00:00:00Z`) : null;
  if (!/^\d+$/.test(String(userId)) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !parsedDate || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('La fecha de pasos no es válida.'), { status: 400 });
  }
  const result = await dbQuery(`SELECT pasos FROM registros_pasos_diarios WHERE usuario_id=${userId} AND fecha=${textSql(date)} LIMIT 1;`);
  return result == null || result === '' ? null : Number(result);
}

const activityAliases = new Map([
  ['run', 'running'], ['correr', 'running'], ['carrera', 'running'], ['runningindoors', 'running'],
  ['walk', 'walking'], ['caminar', 'walking'], ['walkingoutdoors', 'walking'],
  ['cycling', 'cycling'], ['biking', 'cycling'], ['bicicleta', 'cycling'], ['ciclismo', 'cycling'],
  ['swim', 'swimming'], ['natacion', 'swimming'],
  ['strength', 'strengthtraining'], ['weighttraining', 'strengthtraining'], ['weightlifting', 'strengthtraining'], ['entrenamientodepesas', 'strengthtraining'], ['entrenamientodefuerza', 'strengthtraining'], ['pesas', 'strengthtraining'],
  ['hike', 'hiking'], ['senderismo', 'hiking'],
]);

function activityKey(value) {
  const normalized = String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return activityAliases.get(normalized) || normalized;
}

function sameTrainingSession(manual, device) {
  const manualType = activityKey(manual.activity);
  if (!manualType || manualType !== activityKey(device.activity)) return false;
  const manualDuration = Number(manual.durationMinutes);
  const deviceDuration = Number(device.durationMinutes);
  if (![manualDuration, deviceDuration].every(Number.isFinite)
    || Math.abs(manualDuration - deviceDuration) > Math.max(5, Math.max(manualDuration, deviceDuration) * 0.15)) return false;
  const manualTime = Date.parse(manual.createdAt);
  const deviceStart = Date.parse(device.createdAt);
  if (![manualTime, deviceStart].every(Number.isFinite)) return false;
  const deviceEnd = deviceStart + deviceDuration * 60000;
  const inferredManualStart = manualTime - manualDuration * 60000;
  const tolerance = 20 * 60000;
  return Math.min(Math.abs(manualTime - deviceStart), Math.abs(manualTime - deviceEnd), Math.abs(inferredManualStart - deviceStart)) <= tolerance;
}

function calculateTrainingEnergy(records) {
  const manual = records.filter((record) => record.origin === 'manual');
  const device = records.filter((record) => record.energyType === 'reportada_dispositivo' && record.origin !== 'manual');
  const manualMatches = new Map(manual.map((record) => [record, []]));
  const deviceMatches = new Map(device.map((record) => [record, []]));
  for (const manualRecord of manual) for (const deviceRecord of device) {
    if (sameTrainingSession(manualRecord, deviceRecord)) {
      manualMatches.get(manualRecord).push(deviceRecord);
      deviceMatches.get(deviceRecord).push(manualRecord);
    }
  }
  const duplicateManual = new Set();
  const ambiguousManual = new Set();
  const ambiguousDevice = new Set();
  for (const manualRecord of manual) {
    const candidates = manualMatches.get(manualRecord);
    if (candidates.length === 1 && deviceMatches.get(candidates[0]).length === 1) duplicateManual.add(manualRecord);
    else if (candidates.length) {
      ambiguousManual.add(manualRecord);
      for (const deviceRecord of candidates) ambiguousDevice.add(deviceRecord);
    }
  }
  let uncalculableManualCount = 0;
  const manualNetKcal = manual.reduce((sum, record) => {
    if (duplicateManual.has(record) || ambiguousManual.has(record)) return sum;
    const { met, weightKg, durationMinutes } = record;
    if (met == null || weightKg == null || durationMinutes == null
      || !Number.isFinite(Number(met)) || Number(met) <= 0 || Number(met) > 30
      || !Number.isFinite(Number(weightKg)) || Number(weightKg) < 20 || Number(weightKg) > 400
      || !Number.isFinite(Number(durationMinutes)) || Number(durationMinutes) <= 0 || Number(durationMinutes) > 1440) {
      uncalculableManualCount += 1;
      return sum;
    }
    return sum + Math.max(0, (Number(met) - 1) * 3.5 * Number(weightKg) / 200 * Number(durationMinutes));
  }, 0);
  let uncalculableDeviceCount = 0;
  const deviceReportedKcal = device.reduce((sum, record) => {
    if (ambiguousDevice.has(record)) return sum;
    if (record.caloriesKcal == null || !Number.isFinite(Number(record.caloriesKcal)) || Number(record.caloriesKcal) < 0 || Number(record.caloriesKcal) > 100000) {
      uncalculableDeviceCount += 1;
      return sum;
    }
    return sum + Number(record.caloriesKcal);
  }, 0);
  return {
    manualNetKcal: Math.round(manualNetKcal * 10) / 10,
    deviceReportedKcal: Math.round(deviceReportedKcal * 10) / 10,
    adjustmentKcal: Math.round((manualNetKcal + deviceReportedKcal) * 10) / 10,
    manualSessionCount: manual.length - duplicateManual.size - ambiguousManual.size - uncalculableManualCount,
    deviceSessionCount: device.length - ambiguousDevice.size - uncalculableDeviceCount,
    matchedManualDuplicates: duplicateManual.size,
    unresolvedPossibleDuplicates: ambiguousManual.size + ambiguousDevice.size,
    uncalculableManualCount,
    uncalculableDeviceCount,
  };
}

function visibleTrainingEntries(records, preferences) {
  return preferences?.deviceMode === 'garmin' && preferences.garminConnected === true
    ? records : records.filter((record) => record.origin !== 'garmin');
}

async function saveTrainingEntry({ response, data, userId, dbQuery, textSql, json, timezone }) {
  const suppressNotification = data?.suppressNotification === true;
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  const nutritionDate = data.date == null ? null : data.date;
  if (nutritionDate !== null && (typeof nutritionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nutritionDate)
    || Number.isNaN(new Date(`${nutritionDate}T00:00:00Z`).getTime())
    || new Date(`${nutritionDate}T00:00:00Z`).toISOString().slice(0, 10) !== nutritionDate)) {
    json(response, 400, { error: 'La fecha calendario no es válida.' }); return;
  }
  let entry;
  try { entry = validateTrainingEntry(data); }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }
  let createdAt;
  let calendarTimezone;
  let occurredDate;
  try {
    calendarTimezone = await readCalendarTimezone(userId, dbQuery, timezone);
    occurredDate = nutritionDate || localCalendarDate(calendarTimezone);
    createdAt = requestedTrainingTime(entry.description, nutritionDate, calendarTimezone, entry.savedAt);
  }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }
  const traceId = randomUUID();
  let stage = 'persistence';
  try {
    const vigencySql = `(SELECT id FROM vigencias_planes_entrenamiento WHERE usuario_id=${userId} AND fecha_inicio<=${textSql(occurredDate)} AND (fecha_fin IS NULL OR fecha_fin>=${textSql(occurredDate)}) ORDER BY fecha_inicio DESC,id DESC LIMIT 1)`;
    const inserted = await dbQuery(`START TRANSACTION;
SELECT id INTO @locked_user FROM usuarios WHERE id=${userId} FOR UPDATE;
INSERT INTO registros_entrenamientos(usuario_id,plan_vigencia_id,origen,external_activity_id,request_id,descripcion,actividad,duracion_minutos,peso_kg,met,energia_kcal,creado_en) VALUES (${userId},${vigencySql},'manual',NULL,${textSql(entry.requestId)},${textSql(entry.description)},${textSql(entry.activity)},${entry.durationMinutes},${entry.weightKg},${entry.met},${entry.caloriesKcal},${createdAt ? textSql(createdAt) : 'UTC_TIMESTAMP(3)'}) AS incoming ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id);
SELECT LAST_INSERT_ID();
COMMIT;`);
    const entryId = inserted.split(/\s+/).at(-1);
    if (!/^\d+$/.test(entryId || '')) throw new Error('training_insert_failed');
    stage = 'verification';
    const saved = await dbQuery(`SELECT JSON_OBJECT('id',id,'requestId',request_id,'description',descripcion,'activity',actividad,'durationMinutes',duracion_minutos,'weightKg',peso_kg,'met',met,'caloriesKcal',energia_kcal,'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ')) FROM registros_entrenamientos WHERE id=${entryId} AND usuario_id=${userId} LIMIT 1;`);
    if (!saved) throw Object.assign(new Error('training_readback_missing'), { code: 'TRAINING_PERSISTENCE_VERIFY_FAILED' });
    const persisted = JSON.parse(saved);
    if (persisted.requestId !== entry.requestId || persisted.description !== entry.description
      || persisted.activity !== entry.activity || Number(persisted.durationMinutes) !== entry.durationMinutes
      || Number(persisted.weightKg) !== entry.weightKg || Number(persisted.met) !== entry.met
      || Number(persisted.caloriesKcal) !== entry.caloriesKcal) {
      json(response, 409, { error: 'La clave de reintento ya corresponde a otro registro.' });
      return;
    }
    try { await dbQuery(`${resolveNotificationsSql({ userId, category: 'entrenamiento', textSql })};`); } catch {}
    if (!suppressNotification) try { await addNotification({ userId, category: 'entrenamiento', state: 'guardado', title: 'Entrenamiento guardado', message: 'Tu sesión manual quedó guardada.', dbQuery, textSql }); } catch {}
    json(response, 201, { ok: true, entryId: persisted.id, requestId: entry.requestId, caloriesKcal: persisted.caloriesKcal, createdAt: persisted.createdAt, savedAt: entry.savedAt });
  } catch (error) {
    try { await recordTrainingError({ dbQuery, textSql, userId, traceId, stage, error, httpStatus: 503, action: 'POST /api/training-entries' }); }
    catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: traceId })); }
    if (!suppressNotification) try { await addNotification({ userId, category: 'entrenamiento', state: 'error', title: 'No se pudo guardar el entrenamiento', message: 'Intenta guardar la sesión nuevamente.', dbQuery, textSql }); } catch {}
    json(response, 503, { requestId: entry.requestId, traceId, error: stage === 'verification' ? 'El guardado se procesó, pero no se pudo verificar. Reintenta con la misma solicitud.' : 'No se pudo guardar el entrenamiento.' });
  }
}

async function deleteTrainingEntry({ userId, entryId, dbQuery }) {
  if (!/^\d+$/.test(String(userId)) || !/^[1-9]\d*$/.test(String(entryId))) throw Object.assign(new Error('Entrenamiento no válido.'), { status: 400 });
  const result = await dbQuery(`DELETE FROM registros_entrenamientos WHERE id=${entryId} AND usuario_id=${userId}; SELECT ROW_COUNT();`);
  return result.split(/\s+/).at(-1) === '1';
}

async function readTrainingEntries({ userId, dbQuery, date, timezone }) {
  const id = String(userId);
  if (!/^\d+$/.test(id)) throw Object.assign(new Error('Cuenta no válida.'), { status: 400 });
  let dateFilter = '';
  if (date !== undefined) {
    let start;
    let end;
    try {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error();
      const calendarTimezone = await readCalendarTimezone(id, dbQuery, timezone);
      ({ start, end } = calendarDayRange(date, calendarTimezone));
    } catch { throw Object.assign(new Error('La fecha o zona horaria no es válida.'), { status: 400 }); }
    dateFilter = ` AND e.creado_en>='${start}' AND e.creado_en<'${end}'`;
  }
  const rows = await dbQuery(`SET time_zone='+00:00'; SELECT JSON_OBJECT('id',e.id,'createdAt',DATE_FORMAT(e.creado_en,'%Y-%m-%dT%H:%i:%sZ'),'description',e.descripcion,'activity',e.actividad,'durationMinutes',e.duracion_minutos,'weightKg',e.peso_kg,'met',e.met,'caloriesKcal',e.energia_kcal,'distanceMeters',e.distancia_metros,'energyType',e.tipo_energia,'origin',e.origen,'externalActivityId',e.external_activity_id,'plan',IF(p.id IS NULL,NULL,JSON_OBJECT('id',p.id,'goals',p.objetivos,'startDate',DATE_FORMAT(v.fecha_inicio,'%Y-%m-%d'),'endDate',DATE_FORMAT(v.fecha_fin,'%Y-%m-%d')))) FROM registros_entrenamientos e LEFT JOIN vigencias_planes_entrenamiento v ON v.id=e.plan_vigencia_id LEFT JOIN planes_entrenamiento p ON p.id=v.plan_id AND p.usuario_id=e.usuario_id WHERE e.usuario_id=${id}${dateFilter} ORDER BY e.creado_en DESC,e.id DESC LIMIT 100;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

module.exports = { calculateTrainingEnergy, deleteTrainingEntry, localCalendarDate, parseTrainingSavedTime, readDailySteps, readTrainingEntries, recordTrainingError, saveDailySteps, saveTrainingEntry, validateTrainingEntry, visibleTrainingEntries };
