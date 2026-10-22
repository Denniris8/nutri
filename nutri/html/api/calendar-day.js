const { localDateTimeToUtc } = require('./food-entries.js');

function nextDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

async function readCalendarTimezone(userId, dbQuery, fallbackTimezone) {
  const timezone = await dbQuery(`SELECT zona_horaria FROM preferencias_usuario WHERE usuario_id=${userId} LIMIT 1;`);
  return timezone || fallbackTimezone;
}

function calendarDayRange(date, timezone) {
  const endDate = nextDate(date);
  const start = localDateTimeToUtc(date, 0, 0, timezone);
  const end = localDateTimeToUtc(endDate, 0, 0, timezone);
  if (!start || !end) throw Object.assign(new Error('No se pudo calcular el día calendario.'), { status: 400 });
  return { start, end, endDate };
}

module.exports = { calendarDayRange, readCalendarTimezone };
