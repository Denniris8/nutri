const { createRequire } = require('node:module');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decryptGarminCredentials } = require('./integration-credentials.js');
const { nutritionDateForSelection, nutritionWindowRange, readNutritionWindow } = require('./nutrition-window.js');
const { localCalendarDate, saveDailySteps } = require('./training-entries.js');

async function syncGarminTraining({ userId, date, timezone, dbQuery, textSql, secret }) {
  const row = await dbQuery(`SELECT p.modo_dispositivo,HEX(c.ciphertext),HEX(c.nonce),HEX(c.auth_tag),c.key_version FROM preferencias_usuario p JOIN credenciales_integracion_usuario c ON c.usuario_id=p.usuario_id AND c.proveedor='garmin' WHERE p.usuario_id=${userId} LIMIT 1;`);
  const [deviceMode, ciphertext, nonce, authTag, keyVersion] = row.split('\t');
  if (deviceMode !== 'garmin' || keyVersion !== '1') throw Object.assign(new Error('La cuenta Garmin no está vinculada.'), { status: 409 });
  const window = await readNutritionWindow(userId, dbQuery, timezone);
  const nutritionDate = nutritionDateForSelection(date, window);
  const range = nutritionWindowRange(nutritionDate, window);

  let credentials;
  try { credentials = decryptGarminCredentials({ ciphertext, nonce, authTag }, secret); }
  catch { throw new Error('No se pudieron descifrar las credenciales Garmin.'); }

  const garminRoot = path.resolve(__dirname, '../../garmin-connect-mcp');
  const tokenRoot = await mkdtemp(path.join(os.tmpdir(), 'nutri-garmin-sync-'));
  let client;
  let timeout;
  try {
    const fromGarmin = createRequire(path.join(garminRoot, 'package.json'));
    const { Client } = fromGarmin('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = fromGarmin('@modelcontextprotocol/sdk/client/stdio.js');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(garminRoot, 'build/index.js')],
      cwd: garminRoot,
      stderr: 'ignore',
      env: { PATH: process.env.PATH || '', HOME: os.homedir(), GARMIN_EMAIL: credentials.email, GARMIN_PASSWORD: credentials.password, GARMIN_FORCE_LOGIN: '1', GARMIN_TOKEN_DIR: tokenRoot },
    });
    client = new Client({ name: 'nutri-garmin-training-sync', version: '1.0.0' }, { capabilities: {} });
    return await Promise.race([
      (async () => {
        await client.connect(transport);
        const localDate = localCalendarDate(timezone);
        const stepDates = [...new Set(window.endHour === 0 && window.endMinute === 0
          ? [nutritionDate] : [nutritionDate, range.endDate])].filter((stepDate) => stepDate <= localDate);
        const [result, stepResults] = await Promise.all([
          client.callTool({ name: 'get_activities_by_date', arguments: { startDate: nutritionDate, endDate: range.endDate } }, undefined, { timeout: 40000 }),
          Promise.all(stepDates.map(async (stepDate) => {
            try {
              const response = await client.callTool({ name: 'get_steps', arguments: { date: stepDate } }, undefined, { timeout: 40000 });
              if (response.isError) return [stepDate, null];
              const payload = (response.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
              const totalSteps = Number(JSON.parse(payload)?.totalSteps);
              return [stepDate, Number.isSafeInteger(totalSteps) && totalSteps >= 0 && totalSteps <= 250000 ? totalSteps : null];
            } catch { return [stepDate, null]; }
          })),
        ]);
        if (result.isError) throw new Error('Garmin no pudo consultar las actividades.');
        const text = (result.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
        const activities = JSON.parse(text);
        if (!Array.isArray(activities)) throw new Error('Garmin devolvió una lista de actividades no válida.');
        let stepsUpdated = 0;
        let stepsUnavailable = 0;
        for (const [stepDate, stepsCount] of stepResults) {
          if (stepsCount == null) { stepsUnavailable += 1; continue; }
          await saveDailySteps({ userId, date: stepDate, localDate, stepsCount, source: 'garmin', dbQuery, textSql });
          stepsUpdated += 1;
        }
        const rows = new Map(activities.map((activity) => {
          const activityId = Number(activity.activityId);
          const durationSeconds = Number(activity.elapsedDuration ?? activity.duration ?? activity.elapsedDurationInSeconds ?? activity.durationInSeconds);
          const calorieValue = activity.calories ?? activity.caloriesInKiloCalories;
          const calories = Number(calorieValue);
          const startTime = typeof activity.startTimeGMT === 'string' ? activity.startTimeGMT.trim().replace(' ', 'T') : '';
          const timestamp = startTime
            ? Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(startTime) ? startTime : `${startTime}Z`)
            : activity.startTimeInSeconds != null ? Number(activity.startTimeInSeconds) * 1000 : NaN;
          const rawType = activity.activityType;
          const type = rawType?.typeKey || rawType?.typeName || (typeof rawType === 'string' ? rawType : activity.activityName);
          const activityName = typeof activity.activityName === 'string' ? activity.activityName : String(type || '');
          const description = activityName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 1200) || 'Actividad Garmin';
          const activityType = typeof type === 'string' ? type.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120) : '';
          const createdAt = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 23).replace('T', ' ') : '';
          if (!Number.isSafeInteger(activityId) || activityId < 1 || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 86400
            || calorieValue == null || !Number.isFinite(calories) || !createdAt || createdAt < range.start || createdAt >= range.end || !activityType) return [null, null];
          const distanceValue = activity.distanceInMeters ?? activity.distance;
          const distance = distanceValue == null ? NaN : Number(distanceValue);
          return [activityId, {
            id: activityId,
            description,
            activity: activityType,
            duration: Math.round(durationSeconds / 60 * 100) / 100,
            calories: Math.round(calories * 10) / 10,
            distance: Number.isFinite(distance) && distance >= 0 ? Math.round(distance * 100) / 100 : null,
            createdAt,
          }];
        }).filter(([id]) => id !== null));
        if (!rows.size) return { activities: activities.length, saved: 0, skipped: activities.length, stepsUpdated, stepsUnavailable };
        const statements = [...rows.values()].map((activity) => `INSERT IGNORE INTO registros_entrenamientos(usuario_id,descripcion,actividad,duracion_minutos,peso_kg,met,energia_kcal,distancia_metros,tipo_energia,origen,external_activity_id,creado_en) VALUES (${userId},${textSql(activity.description)},${textSql(activity.activity)},${activity.duration},NULL,NULL,${activity.calories},${activity.distance ?? 'NULL'},'reportada_dispositivo','garmin',${textSql(String(activity.id))},${textSql(activity.createdAt)}); SELECT ROW_COUNT();`).join('\n');
        const inserted = await dbQuery(statements);
        const saved = inserted.split(/\s+/).reduce((total, count) => total + (Number(count) === 1 ? 1 : 0), 0);
        return { activities: activities.length, saved, skipped: activities.length - saved, stepsUpdated, stepsUnavailable };
      })(),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Se agotó el tiempo de sincronización Garmin.')), 45000); }),
    ]);
  } finally {
    clearTimeout(timeout);
    try { await client?.close(); } catch {}
    await rm(tokenRoot, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { syncGarminTraining };
