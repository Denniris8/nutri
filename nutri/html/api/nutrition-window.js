const { localDateTimeToUtc } = require('./food-entries.js');

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

async function readNutritionWindow(userId, dbQuery, fallbackTimezone) {
  const row = await dbQuery(`SELECT TIME_FORMAT(nutrition_day_start,'%H:%i:%s'),TIME_FORMAT(nutrition_day_end,'%H:%i:%s'),zona_horaria FROM preferencias_usuario WHERE usuario_id=${userId} LIMIT 1;`);
  const [start = '00:00:00', end = '00:00:00', timezone = fallbackTimezone] = (row || '').split('\t');
  const [startHour, startMinute] = start.split(':').map(Number);
  const [endHour, endMinute] = end.split(':').map(Number);
  return { startHour, startMinute, endHour, endMinute, timezone: timezone || fallbackTimezone };
}

function nutritionWindowRange(date, window) {
  const startMinutes = window.startHour * 60 + window.startMinute;
  const endMinutes = window.endHour * 60 + window.endMinute;
  const endDate = endMinutes <= startMinutes ? nextDate(date) : date;
  const start = localDateTimeToUtc(date, window.startHour, window.startMinute, window.timezone);
  const end = localDateTimeToUtc(endDate, window.endHour, window.endMinute, window.timezone);
  if (!start || !end) throw Object.assign(new Error('No se pudo calcular la ventana nutricional.'), { status: 400 });
  return { start, end, endDate };
}

function nutritionDateForSelection(date, window, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: window.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  return date === today && Number(parts.hour) * 60 + Number(parts.minute) < window.startHour * 60 + window.startMinute
    ? previousDate(date) : date;
}

module.exports = { nextDate, nutritionDateForSelection, nutritionWindowRange, readNutritionWindow };
