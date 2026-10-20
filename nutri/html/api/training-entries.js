const { localDateTimeToUtc, parseFoodTime } = require('./food-entries.js');
const { nextDate, nutritionDateForSelection, nutritionWindowRange, readNutritionWindow } = require('./nutrition-window.js');

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

function requestedTrainingTime(description, date, timezone, savedAt, window) {
  const time = savedAt ? { status: 'specified', value: savedAt } : parseTrainingSavedTime(description);
  if (time.status === 'invalid') throw Object.assign(new Error('La hora indicada no es válida.'), { status: 400 });
  if (time.status === 'ambiguous') throw Object.assign(new Error('Aclara si la hora fue a. m. o p. m., o usa formato de 24 horas.'), { status: 400 });
  if (typeof timezone !== 'string' || !timezone || timezone.length > 64) throw Object.assign(new Error('No se pudo detectar la zona horaria del navegador.'), { status: 400 });
  if (time.status === 'none' && !date) return null;
  const now = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const [hour, minute] = (time.status === 'none' ? `${now.hour}:${now.minute}` : time.value).split(':').map(Number);
  const nutritionDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const targetDate = window && hour * 60 + minute < window.startHour * 60 + window.startMinute ? nextDate(nutritionDate) : nutritionDate;
  const createdAt = localDateTimeToUtc(targetDate, hour, minute, timezone);
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
  if (!activity || activity.length > 120 || /[\u0000-\u001f]/.test(activity)
    || !Number.isFinite(durationMinutes) || durationMinutes <= 0 || durationMinutes > 1440
    || !Number.isFinite(weightKg) || weightKg < 20 || weightKg > 400
    || !Number.isFinite(met) || met <= 0 || met > 30
    || savedAt !== null && (typeof savedAt !== 'string' || !/^\d{2}:\d{2}$/.test(savedAt) || Number(savedAt.slice(0, 2)) > 23 || Number(savedAt.slice(3)) > 59)) throw Object.assign(new Error('El cálculo del entrenamiento está incompleto o la hora no es válida.'), { status: 400 });
  const duration = Number(durationMinutes.toFixed(2));
  const weight = Number(weightKg.toFixed(2));
  const intensity = Number(met.toFixed(2));
  return {
    description, activity, durationMinutes: duration, weightKg: weight, met: intensity, savedAt,
    caloriesKcal: Math.round(intensity * 3.5 * weight / 200 * duration * 10) / 10,
  };
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
    if (![met, weightKg, durationMinutes].every((value) => Number.isFinite(Number(value)))) { uncalculableManualCount += 1; return sum; }
    return sum + Math.max(0, (Number(met) - 1) * 3.5 * Number(weightKg) / 200 * Number(durationMinutes));
  }, 0);
  const deviceReportedKcal = device.reduce((sum, record) => {
    if (ambiguousDevice.has(record) || !Number.isFinite(Number(record.caloriesKcal))) return sum;
    return sum + Number(record.caloriesKcal);
  }, 0);
  return {
    manualNetKcal: Math.round(manualNetKcal * 10) / 10,
    deviceReportedKcal: Math.round(deviceReportedKcal * 10) / 10,
    adjustmentKcal: Math.round((manualNetKcal + deviceReportedKcal) * 10) / 10,
    matchedManualDuplicates: duplicateManual.size,
    unresolvedPossibleDuplicates: ambiguousManual.size + ambiguousDevice.size,
    uncalculableManualCount,
  };
}

function visibleTrainingEntries(records, preferences) {
  return preferences?.deviceMode === 'garmin' && preferences.garminConnected === true
    ? records : records.filter((record) => record.origin !== 'garmin');
}

async function saveTrainingEntry({ response, data, userId, dbQuery, textSql, json, timezone }) {
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  const nutritionDate = data.date == null ? null : data.date;
  if (nutritionDate !== null && (typeof nutritionDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(nutritionDate)
    || Number.isNaN(new Date(`${nutritionDate}T00:00:00Z`).getTime())
    || new Date(`${nutritionDate}T00:00:00Z`).toISOString().slice(0, 10) !== nutritionDate)) {
    json(response, 400, { error: 'La fecha nutricional no es válida.' }); return;
  }
  let entry;
  try { entry = validateTrainingEntry(data); }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }
  let createdAt;
  try {
    const window = await readNutritionWindow(userId, dbQuery, timezone);
    const selectedDate = nutritionDate ? nutritionDateForSelection(nutritionDate, window) : null;
    createdAt = requestedTrainingTime(entry.description, selectedDate, window.timezone, entry.savedAt, window);
  }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }
  try {
    await dbQuery(`INSERT INTO registros_entrenamientos(usuario_id,origen,external_activity_id,descripcion,actividad,duracion_minutos,peso_kg,met,energia_kcal,creado_en) VALUES (${userId},'manual',NULL,${textSql(entry.description)},${textSql(entry.activity)},${entry.durationMinutes},${entry.weightKg},${entry.met},${entry.caloriesKcal},${createdAt ? textSql(createdAt) : 'UTC_TIMESTAMP(3)'});`);
    json(response, 201, { ok: true, caloriesKcal: entry.caloriesKcal, savedAt: entry.savedAt });
  } catch { json(response, 503, { error: 'No se pudo guardar el entrenamiento.' }); }
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
      const window = await readNutritionWindow(id, dbQuery, timezone);
      ({ start, end } = nutritionWindowRange(nutritionDateForSelection(date, window), window));
    } catch { throw Object.assign(new Error('La fecha o zona horaria no es válida.'), { status: 400 }); }
    dateFilter = ` AND creado_en>='${start}' AND creado_en<'${end}'`;
  }
  const rows = await dbQuery(`SET time_zone='+00:00'; SELECT JSON_OBJECT('id',id,'createdAt',DATE_FORMAT(creado_en,'%Y-%m-%dT%H:%i:%sZ'),'description',descripcion,'activity',actividad,'durationMinutes',duracion_minutos,'weightKg',peso_kg,'met',met,'caloriesKcal',energia_kcal,'distanceMeters',distancia_metros,'energyType',tipo_energia,'origin',origen,'externalActivityId',external_activity_id) FROM registros_entrenamientos WHERE usuario_id=${id}${dateFilter} ORDER BY creado_en DESC,id DESC LIMIT 100;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

module.exports = { calculateTrainingEnergy, deleteTrainingEntry, localCalendarDate, parseTrainingSavedTime, readDailySteps, readTrainingEntries, saveDailySteps, saveTrainingEntry, validateTrainingEntry, visibleTrainingEntries };
