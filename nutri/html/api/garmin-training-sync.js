const { createRequire } = require('node:module');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { decryptGarminCredentials } = require('./integration-credentials.js');
const { calendarDayRange, readCalendarTimezone } = require('./calendar-day.js');
const { localCalendarDate, saveDailySteps } = require('./training-entries.js');

async function syncGarminTraining({ userId, date, timezone, dbQuery, textSql, secret }) {
  const row = await dbQuery(`SELECT p.modo_dispositivo,HEX(c.ciphertext),HEX(c.nonce),HEX(c.auth_tag),c.key_version FROM preferencias_usuario p JOIN credenciales_integracion_usuario c ON c.usuario_id=p.usuario_id AND c.proveedor='garmin' WHERE p.usuario_id=${userId} LIMIT 1;`);
  const [deviceMode, ciphertext, nonce, authTag, keyVersion] = row.split('\t');
  if (deviceMode !== 'garmin' || keyVersion !== '1') throw Object.assign(new Error('La cuenta Garmin no está vinculada.'), { status: 409 });
  const calendarTimezone = await readCalendarTimezone(userId, dbQuery, timezone);
  const range = calendarDayRange(date, calendarTimezone);

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
        const localDate = localCalendarDate(calendarTimezone);
        const stepDates = [date].filter((stepDate) => stepDate <= localDate);
        const [result, stepResults] = await Promise.all([
          client.callTool({ name: 'get_activities_by_date', arguments: { startDate: date, endDate: date } }, undefined, { timeout: 40000 }).catch(() => ({ isError: true, content: [] })),
          Promise.all(stepDates.map(async (stepDate) => {
            try {
              const response = await client.callTool({ name: 'get_daily_summary', arguments: { date: stepDate } }, undefined, { timeout: 40000 });
              if (response.isError) return [stepDate, null];
              const payload = (response.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
              const summary = JSON.parse(payload);
              const rawSteps = summary?.totalSteps == null ? NaN : Number(summary.totalSteps);
              const rawActiveKcal = summary?.activeKilocalories == null ? NaN : Number(summary.activeKilocalories);
              const stepsCount = Number.isSafeInteger(rawSteps) && rawSteps >= 0 && rawSteps <= 250000 ? rawSteps : null;
              const activeKcal = Number.isFinite(rawActiveKcal) && rawActiveKcal >= 0 && rawActiveKcal <= 100000 ? rawActiveKcal : null;
              return [stepDate, { stepsCount, activeKcal }];
            } catch { return [stepDate, null]; }
          })),
        ]);
        let activitiesUnavailable = result.isError === true;
        let activities = [];
        if (!activitiesUnavailable) {
          try {
            const text = (result.content || []).filter((part) => part.type === 'text').map((part) => part.text || '').join('\n');
            activities = JSON.parse(text);
            if (!Array.isArray(activities)) { activities = []; activitiesUnavailable = true; }
          } catch { activitiesUnavailable = true; }
        }
        let stepsUpdated = 0;
        let stepsUnavailable = 0;
        let activeCaloriesUpdated = 0;
        let activeCaloriesUnavailable = 0;
        for (const [stepDate, summary] of stepResults) {
          const stepsCount = summary?.stepsCount ?? null;
          if (summary?.activeKcal == null) activeCaloriesUnavailable += 1;
          if (stepsCount == null) { stepsUnavailable += 1; continue; }
          await saveDailySteps({ userId, date: stepDate, localDate, stepsCount, source: 'garmin', activeKcal: summary.activeKcal, dbQuery, textSql });
          stepsUpdated += 1;
          if (summary.activeKcal != null) activeCaloriesUpdated += 1;
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
            || calorieValue == null || !Number.isFinite(calories) || calories < 0 || calories > 9999999 || !createdAt || createdAt < range.start || createdAt >= range.end || !activityType) return [null, null];
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
        if (!rows.size) return { activities: activities.length, activitiesUnavailable, saved: 0, updated: 0, unchanged: 0, skipped: activities.length, stepsUpdated, stepsUnavailable, activeCaloriesUpdated, activeCaloriesUnavailable };
        const vigencySql = `(SELECT id FROM vigencias_planes_entrenamiento WHERE usuario_id=${userId} AND fecha_inicio<=${textSql(date)} AND (fecha_fin IS NULL OR fecha_fin>=${textSql(date)}) ORDER BY fecha_inicio DESC,id DESC LIMIT 1)`;
        const statements = `START TRANSACTION;
SELECT id INTO @locked_user FROM usuarios WHERE id=${userId} FOR UPDATE;
${[...rows.values()].map((activity) => `INSERT INTO registros_entrenamientos(usuario_id,plan_vigencia_id,descripcion,actividad,duracion_minutos,peso_kg,met,energia_kcal,distancia_metros,tipo_energia,origen,external_activity_id,creado_en) VALUES (${userId},${vigencySql},${textSql(activity.description)},${textSql(activity.activity)},${activity.duration},NULL,NULL,${activity.calories},${activity.distance ?? 'NULL'},'reportada_dispositivo','garmin',${textSql(String(activity.id))},${textSql(activity.createdAt)}) ON DUPLICATE KEY UPDATE descripcion=VALUES(descripcion),actividad=VALUES(actividad),duracion_minutos=VALUES(duracion_minutos),energia_kcal=VALUES(energia_kcal),distancia_metros=VALUES(distancia_metros),creado_en=VALUES(creado_en); SELECT ROW_COUNT();`).join('\n')}
COMMIT;`;
        const counts = (await dbQuery(statements)).split(/\s+/).filter(Boolean).map(Number);
        const saved = counts.filter((count) => count === 1).length;
        const updated = counts.filter((count) => count === 2).length;
        const unchanged = counts.filter((count) => count === 0).length;
        return { activities: activities.length, activitiesUnavailable, saved, updated, unchanged, skipped: activities.length - rows.size, stepsUpdated, stepsUnavailable, activeCaloriesUpdated, activeCaloriesUnavailable };
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
