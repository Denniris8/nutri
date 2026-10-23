const { randomUUID } = require('node:crypto');
const { deleteFoodOpenCodeSession, ensureFoodOpenCodeSession, recordFoodError, requestFoodDescription, safeOpenCodeErrorCode, traceFoodSession, withFoodSessionLock } = require('./opencode-food.js');
const { notificationInsertSql, resolveNotificationsSql } = require('./notifications.js');

function validateFoodEntry(data) {
  const fecha = typeof data?.fecha === 'string' ? data.fecha : '';
  const parsedDate = new Date(`${fecha}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== fecha) {
    throw Object.assign(new Error('La fecha de registro no es válida.'), { status: 400 });
  }
  const descripcion = typeof data.descripcion === 'string' ? data.descripcion.trim() : '';
  if (!descripcion || descripcion.length > 5000) throw Object.assign(new Error('Describe los alimentos consumidos (máximo 5000 caracteres).'), { status: 400 });
  const requestId = typeof data.requestId === 'string' ? data.requestId : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw Object.assign(new Error('La solicitud de guardado no es válida.'), { status: 400 });
  }
  const targetEntryId = data.targetEntryId == null ? null : String(data.targetEntryId);
  if (targetEntryId !== null && !/^[1-9]\d*$/.test(targetEntryId)) throw Object.assign(new Error('La comida a modificar no es válida.'), { status: 400 });
  const timezone = typeof data.timezone === 'string' && data.timezone.length <= 64 ? data.timezone : 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw Object.assign(new Error('La zona horaria no es válida.'), { status: 400 }); }
  return { fecha, descripcion, requestId, timezone, targetEntryId };
}

function parseFoodTime(text) {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, '');
  const meridiem = [...normalized.matchAll(/\b(?:a\s+las?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\s*m|p\s*m|de la manana|de la tarde|de la noche)\b/g)].at(-1);
  if (meridiem) {
    const hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] || 0);
    if (hour < 1 || hour > 12 || minute > 59) return { invalid: true };
    const suffix = meridiem[3].replace(/\s/g, '');
    const pm = suffix === 'pm' || /tarde|noche/.test(suffix);
    return { hours: [hour % 12 + (pm ? 12 : 0)], minute, precision: meridiem[2] ? 'minute' : 'hour' };
  }
  const clock = [...normalized.matchAll(/\b(?:a\s+las?\s+)?(\d{1,2}):(\d{2})\b/g)].at(-1)
    || [...normalized.matchAll(/\ba\s+las?\s+(\d{1,2})\b/g)].at(-1);
  if (!clock) return null;
  const hour = Number(clock[1]);
  const minute = Number(clock[2] || 0);
  if (hour > 23 || minute > 59) return { invalid: true };
  const precision = clock[2] ? 'minute' : 'hour';
  return hour > 0 && hour < 13
    ? { hours: [hour % 12, hour % 12 + 12], minute, precision, ambiguous: true }
    : { hours: [hour], minute, precision };
}

function formatFoodTime(hour, minute) {
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function chatFoodDate(text, timezone) {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const dates = [];
  const add = (year, month, day) => {
    const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw Object.assign(new Error('La fecha indicada en el chat no es válida.'), { status: 400 });
    dates.push(value);
  };
  for (const match of normalized.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(+match[1], +match[2], +match[3]);
  for (const match of normalized.matchAll(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/g)) add(+match[3], +match[2], +match[1]);
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const currentYear = Number(new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(new Date()));
  for (const match of normalized.matchAll(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/g)) {
    const year = +(match[3] || currentYear);
    add(year, months.indexOf(match[2]) + 1, +match[1]);
  }
  const todayParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(({ type, value }) => [type, value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  if (/\banteayer\b/.test(normalized)) dates.push(previousDate(previousDate(today)));
  else if (/\bayer\b/.test(normalized)) dates.push(previousDate(today));
  else if (/\bhoy\b/.test(normalized)) dates.push(today);
  const unique = [...new Set(dates)];
  if (unique.length > 1) throw Object.assign(new Error('Indica una sola fecha para guardar la comida.'), { status: 400 });
  return unique[0] || null;
}

function earlyFoodDayChoice(question, answer) {
  if (!/¿Esta comida pertenece al día nutricional seleccionado(?:\s*\([^)]*\))? o al anterior\?/i.test(String(question || ''))) return null;
  const text = String(answer).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/\b(anterior|dia anterior|ayer)\b/.test(text)) return 'anterior';
  if (/\b(actual|seleccionado|este dia|hoy)\b/.test(text)) return 'actual';
  return null;
}

function previousDaySaveAnswer(question, answer) {
  if (!/¿La guardo en el día nutricional anterior .*11:59:59 p\. m\./i.test(String(question || ''))) return null;
  const text = String(answer).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, '');
  if (/\b(?:11:59:59\s*p\s*m|23:59:59)\b/.test(text)) return { confirmed: true, time: { hours: [23], minute: 59 }, lastSecond: true };
  const time = parseFoodTime(answer);
  if (time && !time.invalid && !time.ambiguous && time.hours.length === 1) return { confirmed: true, time, lastSecond: false };
  if (/\b(si|confirmo|confirmar|correcto|de acuerdo|asi esta bien)\b/.test(text)) return { confirmed: true, time: { hours: [23], minute: 59 }, lastSecond: true };
  return { confirmed: false };
}

function confirmedFoodDate(question, answer, timezone, previousSaveAnswer) {
  const normalizedQuestion = String(question || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const normalizedAnswer = String(answer || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const confirmsSaving = /\b(?:guardar|guardo|guardarla|guardemos)\b/.test(normalizedQuestion)
    && /\b(?:dia|fecha)\b/.test(normalizedQuestion)
    && (previousSaveAnswer?.confirmed || /^\s*(?:si|confirmo|correcto|de acuerdo|claro|adelante)\b/.test(normalizedAnswer));
  if (!confirmsSaving) return null;
  try { return chatFoodDate(question, timezone); } catch { return null; }
}

function localDateTimeToUtc(fecha, hour, minute, timezone) {
  const [year, month, day] = fecha.split('-').map(Number);
  const wallTime = Date.UTC(year, month - 1, day, hour, minute);
  let instant = wallTime;
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]));
    const observed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    const difference = wallTime - observed;
    if (!difference) return new Date(instant).toISOString().slice(0, 19).replace('T', ' ');
    instant += difference;
  }
  return null;
}

async function readFoodEntries({ userId, fecha, dbQuery, textSql }) {
  if (!/^\d+$/.test(String(userId))) throw Object.assign(new Error('Cuenta no válida.'), { status: 400 });
  const date = typeof fecha === 'string' ? fecha : '';
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error('La fecha no es válida.'), { status: 400 });
  }
  const rows = await dbQuery(`SET time_zone='+00:00'; SELECT JSON_OBJECT('id',e.id,'fecha',DATE_FORMAT(e.fecha_consumo,'%Y-%m-%d'),'createdAt',DATE_FORMAT(e.creado_en,'%Y-%m-%dT%H:%i:%sZ'),'state',e.estado,'description',e.descripcion_original) FROM registros_comidas e WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} AND e.estado<>'borrador_chat' ORDER BY e.creado_en,e.id LIMIT 100;`);
  const records = rows ? rows.split(/\r?\n/).map((row) => ({ ...JSON.parse(row), items: [], clarifications: [] })) : [];
  if (!records.length) return records;
  const items = await dbQuery(`SELECT JSON_OBJECT('entryId',i.registro_comida_id,'itemId',CAST(i.id AS CHAR),'sourceText',i.fragmento_original,'name',i.nombre_alimento,'quantity',i.cantidad_texto,'quantityGrams',i.cantidad_g,'basis',i.base_macros,'energyKcal',i.energia_kcal,'proteinG',i.proteina_g,'carbohydrateG',i.carbohidratos_g,'fatG',i.grasa_g,'fiberG',i.fibra_g,'macroStatus',i.estado_macros,'macroSource',i.fuente_macros,'sourceName',i.nombre_fuente_web,'sourceUrl',i.url_fuente_web,'sourceQuote',i.cita_fuente) FROM registros_comida_items i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} ORDER BY e.creado_en,e.id,i.id;`);
  const byEntry = new Map(records.map((record) => [String(record.id), record.items]));
  if (items) for (const row of items.split(/\r?\n/)) {
    const item = JSON.parse(row);
    byEntry.get(String(item.entryId))?.push(item);
  }
  const clarifications = await dbQuery(`SELECT JSON_OBJECT('entryId',i.registro_comida_id,'content',i.contenido) FROM registros_comida_interacciones i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} AND e.estado='completado' AND i.role='user' AND i.id>(SELECT MIN(firstTurn.id) FROM registros_comida_interacciones firstTurn WHERE firstTurn.registro_comida_id=i.registro_comida_id AND firstTurn.role='user') ORDER BY i.registro_comida_id,i.id;`);
  const byClarificationEntry = new Map(records.map((record) => [String(record.id), record.clarifications]));
  if (clarifications) for (const row of clarifications.split(/\r?\n/)) {
    const clarification = JSON.parse(row);
    byClarificationEntry.get(String(clarification.entryId))?.push(clarification.content);
  }
  return records;
}

async function readPendingFoodDraft({ userId, dbQuery }) {
  const row = await dbQuery(`SELECT JSON_OBJECT('id',e.id,'requestId',e.request_id,'fecha',DATE_FORMAT(e.fecha_consumo,'%Y-%m-%d'),'description',e.descripcion_original,'question',e.pregunta_pendiente,'state',e.estado) FROM registros_comidas e WHERE e.usuario_id=${userId} AND e.estado='borrador_chat' ORDER BY e.actualizado_en DESC,e.id DESC LIMIT 1;`);
  if (!row) return null;
  const draft = JSON.parse(row);
  const messages = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${draft.id} ORDER BY id;`);
  draft.messages = messages ? messages.split(/\r?\n/).map((message) => JSON.parse(message)).filter((message) => !isLegacyFoodNameError(message) && !isFoodIdentityRefusal(message)) : [];
  if (isLegacyFoodNameError({ role: 'assistant', content: draft.question }) || isFoodIdentityRefusal({ role: 'assistant', content: draft.question })) draft.question = null;
  if (!draft.messages.length && draft.question) draft.messages = [{ role: 'user', content: draft.description }, { role: 'assistant', content: draft.question }];
  return draft;
}

function isLegacyFoodNameError(message) {
  return message?.role === 'assistant' && /^No pude confirmar que [“"]ese alimento[”"] corresponda a lo escrito\. Aclara su nombre en la misma descripción\.?$/.test(String(message.content || '').trim());
}

function isFoodErrorMessage(message) {
  return message?.role === 'assistant' && String(message.content || '').startsWith('[ERROR_REGISTRO] ');
}

function isFoodIdentityRefusal(message) {
  const content = String(message?.content || '').replace(/\s+/g, ' ');
  return message?.role === 'assistant' && /no se registr[oó].*identidad autenticada|no me proporciona la identidad autenticada|no usar[eé] un usuario ni una sesi[oó]n supuesta|(?:sin|no (?:tengo|cuento con|dispongo de)).{0,100}(?:contexto|identidad).{0,80}(?:autenticad|sesi[oó]n)|no (?:have|has).{0,60}authenticated (?:session )?context|missing authenticated (?:session )?context/i.test(content);
}

async function readFoodConversationText({ entryId, dbQuery, fallback }) {
  const rows = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`);
  const messages = rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)).filter((message) => !isLegacyFoodNameError(message) && !isFoodErrorMessage(message) && !isFoodIdentityRefusal(message)) : [];
  return messages.map((message) => `${message.role === 'user' ? 'Usuario' : 'Asistente'}: ${message.content}`).join('\n') || fallback;
}

async function readFoodUserText({ entryId, dbQuery }) {
  const rows = await dbQuery(`SELECT JSON_OBJECT('content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} AND role='user' ORDER BY id;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row).content).join('\n') : '';
}

async function readDraftFoodItems({ entryId, userId, dbQuery }) {
  const rows = await dbQuery(`SELECT JSON_OBJECT('sourceText',i.fragmento_original,'name',i.nombre_alimento,'quantityText',i.cantidad_texto,'quantityGrams',i.cantidad_g,'macroBasis',i.base_macros,'macroStatus',i.estado_macros,'macroSource',i.fuente_macros,'sourceName',i.nombre_fuente_web,'sourceUrl',i.url_fuente_web,'sourceQuote',i.cita_fuente,'macros',JSON_OBJECT('energyKcal',i.energia_kcal,'proteinG',i.proteina_g,'carbohydrateG',i.carbohidratos_g,'fatG',i.grasa_g,'fiberG',i.fibra_g)) FROM registros_comida_items i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.id=${entryId} AND e.usuario_id=${userId} AND e.estado='borrador_chat' ORDER BY i.id;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

async function saveFoodInteraction({ dbQuery, textSql, entryId, role, content }) {
  const previous = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id DESC LIMIT 1;`);
  if (previous) {
    const last = JSON.parse(previous);
    if (last.role === role && last.content === content) return;
  }
  await dbQuery(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${entryId},${textSql(role)},${textSql(content.slice(0,5000))});`);
}

async function deleteFoodEntry({ userId, entryId, dbQuery }) {
  if (!/^\d+$/.test(String(userId)) || !/^[1-9]\d*$/.test(String(entryId))) throw Object.assign(new Error('Registro no válido.'), { status: 400 });
  const result = await dbQuery(`DELETE FROM registros_comidas WHERE id=${entryId} AND usuario_id=${userId}; SELECT ROW_COUNT();`);
  return result.split(/\s+/).at(-1) === '1';
}

function parseFoodReply(parts) {
  const rawText = parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
  const structured = parts.find((part) => part.type === 'tool' && part.state?.input && typeof part.state.input === 'object'
    && (Array.isArray(part.state.input.items) || part.state.input.clarificationQuestion))?.state?.input;
  if (isFoodIdentityRefusal({ role: 'assistant', content: structured?.clarificationQuestion }) || isFoodIdentityRefusal({ role: 'assistant', content: rawText })) {
    throw Object.assign(new Error('El asistente intentó solicitar la identidad del usuario.'), { code: 'FOOD_IDENTITY_REFUSAL' });
  }
  const text = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const assistantMessages = rawText && !text.startsWith('{') && !text.startsWith('[') ? [rawText.slice(0, 5000)] : [];
  if (structured) return {
    ...structured,
    assistantMessages: assistantMessages.filter((message) => message !== structured.clarificationQuestion),
    ...(!structured.clarificationQuestion && !structured.items?.length && assistantMessages.length ? { clarificationQuestion: assistantMessages[0] } : {}),
  };
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  try {
    if (start < 0 || end < start) throw new Error();
    return { ...JSON.parse(text.slice(start, end + 1)), assistantMessages };
  } catch {
    if (rawText) return { items: [], clarificationQuestion: rawText.slice(0, 5000), assistantMessages: [] };
    throw new Error('El asistente devolvió una respuesta de comida no válida.');
  }
}

function normalizeFoodReply(reply) {
  if (!reply || typeof reply !== 'object' || !Array.isArray(reply.items)) return reply;
  const bases = { per_portion: 'per_portion', portion: 'per_portion', porcion: 'per_portion', per_100g: 'per_100g', per100g: 'per_100g', '100g': 'per_100g' };
  const statuses = { estimado: 'estimado', estimated: 'estimado', declared: 'declarado', declarado: 'declarado', declarado_usuario: 'declarado', verified: 'declarado', verificado: 'declarado' };
  const sources = { webfetch: 'webfetch', web: 'webfetch', internet: 'webfetch', usda: 'webfetch', declarado_usuario: 'declarado_usuario', declared: 'declarado_usuario', user: 'declarado_usuario', opencode_estimado: 'opencode_estimado', estimated: 'opencode_estimado' };
  const actions = { new: 'new', nueva: 'new', append: 'append', agregar: 'append', anexar: 'append', append_to_existing: 'append', add_to_existing: 'append', update: 'update', actualizar: 'update', corregir: 'update', correction: 'update' };
  const action = actions[String(reply.action || '').toLowerCase()] || null;
  const target = reply.targetEntryId ?? reply.target_entry_id;
  return { ...reply, items: reply.items.map((item) => {
    const quantityGrams = typeof item?.quantityGrams === 'string' && item.quantityGrams.trim() ? Number(item.quantityGrams) : item?.quantityGrams;
    const sourceUrl = item?.sourceUrl || item?.sourceURL || item?.source_url;
    const macroStatus = statuses[String(item?.macroStatus || '').toLowerCase()] || item?.macroStatus;
    const sourceName = item?.sourceName || item?.source_name || item?.sourceTitle;
    const sourceQuote = item?.sourceQuote || item?.source_quote || item?.sourceCitation;
    const requestedSource = sources[String(item?.macroSource || item?.source || '').toLowerCase()];
    const webSourceValid = typeof sourceName === 'string' && sourceName.trim() && typeof sourceQuote === 'string' && sourceQuote.trim()
      && typeof sourceUrl === 'string' && sourceUrl.length <= 1000 && (() => { try { const url = new URL(sourceUrl); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; } })();
    const macroSource = requestedSource === 'webfetch' && !webSourceValid ? 'opencode_estimado'
      : requestedSource || (sourceUrl && webSourceValid ? 'webfetch' : macroStatus === 'declarado' ? 'declarado_usuario' : 'opencode_estimado');
    return {
      ...item,
      ...((item?.targetItemId ?? item?.target_item_id) == null ? {} : { targetItemId: String(item.targetItemId ?? item.target_item_id) }),
      sourceText: item?.sourceText || item?.name,
      quantityGrams,
      macroBasis: bases[String(item?.macroBasis || '').toLowerCase()] || 'per_portion',
      macroStatus: macroSource === 'opencode_estimado' ? 'estimado' : macroStatus,
      macroSource,
      sourceName: macroSource === 'webfetch' ? sourceName : null,
      sourceUrl: macroSource === 'webfetch' ? sourceUrl : null,
      sourceQuote: macroSource === 'webfetch' ? sourceQuote : null,
      macros: item?.macros && Object.fromEntries(['energyKcal', 'proteinG', 'carbohydrateG', 'fatG', 'fiberG'].map((key) => [key, typeof item.macros[key] === 'string' && item.macros[key].trim() ? Number(item.macros[key]) : item.macros[key]])),
    };
  }), action, targetEntryId: target == null ? null : String(target) };
}

function foodItemIssues(item) {
  const issues = [];
  if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 150) issues.push('name');
  if (typeof item?.sourceText !== 'string' || !item.sourceText.trim() || item.sourceText.length > 500) issues.push('sourceText');
  if (!['per_100g', 'per_portion'].includes(item?.macroBasis)) issues.push('macroBasis');
  if (!['estimado', 'declarado'].includes(item?.macroStatus)) issues.push('macroStatus');
  if (!['declarado_usuario', 'webfetch', 'opencode_estimado'].includes(item?.macroSource)) issues.push('macroSource');
  const macros = item?.macros;
  if (!macros || !['energyKcal', 'proteinG', 'carbohydrateG', 'fatG'].every((key) => Number.isFinite(macros[key]) && macros[key] >= 0 && macros[key] <= 99999999.99)
      || macros.fiberG != null && (!Number.isFinite(macros.fiberG) || macros.fiberG < 0 || macros.fiberG > 99999999.99)) issues.push('macros');
  if (item?.quantityGrams != null && (!Number.isFinite(item.quantityGrams) || item.quantityGrams <= 0 || item.quantityGrams > 9999999.999)) issues.push('quantityGrams');
  if (item?.quantityText != null && (typeof item.quantityText !== 'string' || item.quantityText.length > 100)) issues.push('quantityText');
  const referenceGrams = Number.isFinite(item?.quantityGrams) && item.quantityGrams > 0 ? item.quantityGrams : item?.macroBasis === 'per_100g' ? 100 : null;
  if (macros && referenceGrams != null
      && ['proteinG', 'carbohydrateG', 'fatG', 'fiberG'].some((key) => macros[key] != null
        && macros[key] * (item.macroBasis === 'per_100g' && Number.isFinite(item.quantityGrams) ? item.quantityGrams / 100 : 1) > referenceGrams * 1.05)) issues.push('macro_unit_bounds');
  const factor = item?.macroBasis === 'per_100g' && Number.isFinite(item.quantityGrams) ? item.quantityGrams / 100 : 1;
  const energy = macros?.energyKcal * factor;
  if (referenceGrams != null && Number.isFinite(energy) && energy > referenceGrams * 9.5) issues.push('energy_unit_bounds');
  if (macros && macros.fiberG != null && Number.isFinite(macros.energyKcal)
      && ['proteinG', 'carbohydrateG', 'fatG'].every((key) => Number.isFinite(macros[key]))) {
    const expected = (4 * macros.proteinG + 4 * macros.carbohydrateG + 9 * macros.fatG) * factor;
    if (Math.abs(energy - expected) > Math.max(25, energy * 0.25, macros.fiberG * factor * 2)) issues.push('energy_4_4_9_mismatch');
  }
  if (item?.targetItemId != null && !/^[1-9]\d*$/.test(String(item.targetItemId))) issues.push('targetItemId');
  if (item?.macroSource === 'webfetch') {
    if (typeof item.sourceName !== 'string' || !item.sourceName.trim() || item.sourceName.length > 255) issues.push('sourceName');
    if (typeof item.sourceQuote !== 'string' || !item.sourceQuote.trim() || item.sourceQuote.length > 1200) issues.push('sourceQuote');
    try { const url = new URL(item.sourceUrl); if (url.protocol !== 'https:' || url.username || url.password || item.sourceUrl.length > 1000) issues.push('sourceUrl'); }
    catch { issues.push('sourceUrl'); }
  }
  return issues;
}

function validFoodItem(item) {
  return foodItemIssues(item).length === 0;
}

function explicitFoodMasses(description) {
  return [...String(description).matchAll(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(kg|kilogramos?|gr|g|gramos?)\b/gi)]
    .map((match) => Number(match[1].replace(',', '.')) * (/^(?:kg|kilogramos?)$/i.test(match[2]) ? 1000 : 1))
    .filter((grams) => Number.isFinite(grams) && grams > 0 && grams <= 9999999.999);
}

function applyExplicitGrams(items, description, allowUniqueMissing = false) {
  const missing = items.filter((item) => item && item.quantityGrams == null);
  const amounts = explicitFoodMasses(description);
  if ((items.length === 1 || allowUniqueMissing) && missing.length === 1 && amounts.length === 1) {
    const grams = amounts[0];
    missing[0].quantityGrams = grams;
    missing[0].quantityText ||= `${grams} g`;
  }
  return items;
}

function isQuantityQuestion(text) {
  return /(?:cu[aá]ntos gramos|cantidad en gramos|peso aproximado)/i.test(String(text || ''));
}

function pendingFoodItemSql(entryId, item, textSql) {
  const macros = item.macros;
  const value = (field) => field == null ? 'NULL' : textSql(field);
  const energy449 = 4 * macros.proteinG + 4 * macros.carbohydrateG + 9 * macros.fatG;
  const method = item.macroSource === 'webfetch' ? 'webfetch' : item.macroSource === 'opencode_estimado' ? 'opencode_estimado' : 'declarado_usuario';
  const fields = [entryId, textSql(item.sourceText), textSql(item.name.trim()), value(item.sourceName), value(item.sourceUrl), value(item.sourceQuote), value(item.quantityText), item.quantityGrams == null ? 'NULL' : item.quantityGrams, textSql(item.macroSource), textSql(method), textSql(item.macroBasis), textSql(item.macroStatus), macros.energyKcal, energy449, macros.proteinG, macros.carbohydrateG, macros.fatG, value(macros.fiberG)];
  return `INSERT INTO registros_comida_items(registro_comida_id,fragmento_original,nombre_alimento,nombre_fuente_web,url_fuente_web,cita_fuente,cantidad_texto,cantidad_g,fuente_macros,metodo_energia,base_macros,estado_macros,energia_kcal,energia_449_kcal,proteina_g,carbohidratos_g,grasa_g,fibra_g) VALUES (${fields.join(',')})`;
}

async function saveFoodEntry({ response, data, userId, dbQuery, textSql, json, requestOpenCode }) {
  const suppressNotification = data?.suppressNotification === true;
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  let entry;
  try { entry = validateFoodEntry(data); }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }

  const trace = { id: randomUUID(), events: [] };
  traceFoodSession(trace, 'save_received');
  let entryId;
  let committed = false;
  let committedEntryId;
  let committedConfirmation;
  let stage = 'draft';
  try {
    const preferenceTimezone = await dbQuery(`SELECT zona_horaria FROM preferencias_usuario WHERE usuario_id=${userId} LIMIT 1;`);
    if (preferenceTimezone) entry.timezone = preferenceTimezone;
    const existingDraftDate = await dbQuery(`SELECT DATE_FORMAT(fecha_consumo,'%Y-%m-%d') FROM registros_comidas WHERE usuario_id=${userId} AND request_id=${textSql(entry.requestId)} AND estado='borrador_chat' LIMIT 1;`);
    const requestedChatDate = chatFoodDate(entry.descripcion, entry.timezone);
    if (requestedChatDate) {
      entry.fecha = requestedChatDate;
      if (existingDraftDate && existingDraftDate !== requestedChatDate) {
        await dbQuery(`UPDATE registros_comidas SET fecha_consumo=${textSql(requestedChatDate)},registro_comida_destino_id=NULL,pregunta_pendiente=NULL WHERE usuario_id=${userId} AND request_id=${textSql(entry.requestId)} AND estado='borrador_chat';`);
        entry.targetEntryId = null;
      }
    } else if (existingDraftDate) entry.fecha = existingDraftDate;
    const appended = await dbQuery(`SELECT JSON_OBJECT('entryId',e.id,'fecha',DATE_FORMAT(e.fecha_consumo,'%Y-%m-%d')) FROM registros_comida_interacciones i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND i.request_id=${textSql(entry.requestId)} LIMIT 1;`);
    if (appended) {
      const prior = JSON.parse(appended);
      json(response, 200, { state: 'completado', entryId: prior.entryId, records: await readFoodEntries({ userId, fecha: prior.fecha, dbQuery, textSql }), message: 'Los alimentos ya se habían añadido a esa comida.' });
      return;
    }
    if (entry.targetEntryId && !await dbQuery(`SELECT id FROM registros_comidas WHERE id=${entry.targetEntryId} AND usuario_id=${userId} AND fecha_consumo=${textSql(entry.fecha)} AND estado='completado' LIMIT 1;`)) {
      json(response, 404, { error: 'La comida que quieres ajustar ya no está disponible.' });
      return;
    }
    const inserted = await dbQuery(`INSERT INTO registros_comidas(usuario_id,registro_comida_destino_id,request_id,fecha_consumo,descripcion_original,estado,creado_en) VALUES (${userId},${entry.targetEntryId || 'NULL'},${textSql(entry.requestId)},${textSql(entry.fecha)},${textSql(entry.descripcion)},'borrador_chat',CURRENT_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id);
SELECT LAST_INSERT_ID();`);
    entryId = inserted.split(/\s+/).at(-1);
    if (!/^\d+$/.test(entryId || '')) throw new Error('food_entry_insert_failed');
    traceFoodSession(trace, 'entry_saved', { entryId });

    const saved = JSON.parse(await dbQuery(`SELECT JSON_OBJECT('state',estado,'fecha',DATE_FORMAT(fecha_consumo,'%Y-%m-%d'),'description',descripcion_original,'question',pregunta_pendiente,'targetEntryId',registro_comida_destino_id) FROM registros_comidas WHERE id=${entryId} AND usuario_id=${userId} LIMIT 1;`));
    if (saved.state === 'completado') {
      json(response, 200, { state: 'completado', entryId, records: await readFoodEntries({ userId, fecha: saved.fecha, dbQuery, textSql }), message: 'Esta comida ya estaba guardada.' });
      return;
    }
    if (saved.fecha !== entry.fecha) throw Object.assign(new Error('La fecha del borrador no coincide.'), { status: 409 });

    const identityRefusal = isFoodIdentityRefusal({ role: 'assistant', content: saved.question });
    if (['borrador_chat', 'requiere_aclaracion'].includes(saved.state) && saved.question && !isLegacyFoodNameError({ role: 'assistant', content: saved.question }) && !identityRefusal) {
      await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'user', content: saved.description });
      await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'assistant', content: saved.question });
    }
    const pendingFoodItems = saved.question ? await readDraftFoodItems({ entryId, userId, dbQuery }) : [];
    await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'user', content: entry.descripcion });
    const asksTimeChoice = /Hay varias comidas a esa hora|¿Te refieres a las .*a\. m\. o p\. m\./i.test(saved.question || '');
    const asksDayChoice = /¿Esta comida pertenece al día nutricional seleccionado(?:\s*\([^)]*\))? o al anterior\?/i.test(saved.question || '');
    const asksPreviousDayConfirmation = /¿La guardo en el día nutricional anterior .*11:59:59 p\. m\./i.test(saved.question || '');
    const priorUserText = asksTimeChoice || asksDayChoice || asksPreviousDayConfirmation ? await readFoodUserText({ entryId, dbQuery }) : '';
    const requestedTime = parseFoodTime(entry.descripcion) || (priorUserText ? parseFoodTime(priorUserText) : null);
    const dayChoice = asksDayChoice ? earlyFoodDayChoice(saved.question, entry.descripcion) : null;
    const previousSaveAnswer = asksPreviousDayConfirmation ? previousDaySaveAnswer(saved.question, entry.descripcion) : null;
    const confirmedDate = confirmedFoodDate(saved.question, entry.descripcion, entry.timezone, previousSaveAnswer);
    if (confirmedDate && confirmedDate !== entry.fecha) {
      await dbQuery(`UPDATE registros_comidas SET fecha_consumo=${textSql(confirmedDate)},registro_comida_destino_id=NULL WHERE id=${entryId} AND usuario_id=${userId} AND estado='borrador_chat';`);
      entry.fecha = confirmedDate;
      entry.targetEntryId = null;
    }
    const dayMeals = (await readFoodEntries({ userId, fecha: entry.fecha, dbQuery, textSql })).filter((record) => record.state === 'completado').map((record) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: entry.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(record.createdAt)).map(({ type, value }) => [type, value]));
      return {
        id: String(record.id), hora: new Intl.DateTimeFormat('es-MX', { timeZone: entry.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(record.createdAt)),
        hour24: Number(parts.hour), minute: Number(parts.minute),
        alimentos: record.items.map((item) => `${item.name}${item.quantity ? ` (${item.quantity})` : ''}`),
        items: record.items.map(({ itemId, sourceText, name, quantity, quantityGrams, basis, energyKcal, proteinG, carbohydrateG, fatG, fiberG, macroStatus, macroSource, sourceName, sourceUrl, sourceQuote }) => ({ targetItemId: String(itemId), sourceText, name, quantity, quantityGrams, basis, energyKcal, proteinG, carbohydrateG, fatG, fiberG, macroStatus, macroSource, sourceName, sourceUrl, sourceQuote })),
        ...(record.items.length ? {} : { descripcion: record.description }),
      };
    });
    const continuationTarget = entry.targetEntryId == null ? null : dayMeals.find((meal) => String(meal.id) === String(entry.targetEntryId));
    const pendingTarget = !requestedTime && saved.question && saved.targetEntryId != null
      ? dayMeals.find((meal) => String(meal.id) === String(saved.targetEntryId))
      : null;
    const activeTarget = continuationTarget || pendingTarget;
    const matchedMeals = activeTarget ? [activeTarget] : requestedTime && !requestedTime.invalid
      ? dayMeals.filter((meal) => requestedTime.hours.includes(meal.hour24) && (requestedTime.precision === 'hour' || requestedTime.minute === meal.minute))
      : dayMeals;
    if (requestedTime?.ambiguous && matchedMeals.length === 1) requestedTime.hours = [matchedMeals[0].hour24];
    const mealsForModel = matchedMeals;
    let modelDescription = entry.descripcion;
    if (identityRefusal) {
      modelDescription = await readFoodConversationText({ entryId, dbQuery, fallback: entry.descripcion });
      await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
      traceFoodSession(trace, 'identity_refusal_session_reset');
    }
    let sessionId = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode, trace });
    stage = 'analysis';
    const requestArgs = { sessionId, description: modelDescription, comidasDisponibles: mealsForModel, alimentosPendientes: pendingFoodItems, continuacionRegistro: Boolean(activeTarget), diaNutricional: entry.fecha, trace, requestOpenCode };
    let parts = await withFoodSessionLock(userId, () => requestFoodDescription(requestArgs));
    stage = 'parse';
    let result;
    const parseReply = (responseParts) => {
      try { return normalizeFoodReply(parseFoodReply(responseParts)); }
      catch (error) { if (error.code === 'FOOD_IDENTITY_REFUSAL') throw error; return null; }
    };
    try { result = parseReply(parts); }
    catch (error) {
      traceFoodSession(trace, 'reply_parse_failed', { partTypes: parts.map((part) => part.type) });
      if (error.code !== 'FOOD_IDENTITY_REFUSAL') throw error;
      modelDescription = await readFoodConversationText({ entryId, dbQuery, fallback: entry.descripcion });
      await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
      traceFoodSession(trace, 'identity_refusal_session_reset');
      sessionId = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode, trace });
      stage = 'analysis';
      parts = await withFoodSessionLock(userId, () => requestFoodDescription({ ...requestArgs, sessionId, description: modelDescription }));
      stage = 'parse';
      result = parseReply(parts);
    }
    const pendingMasses = explicitFoodMasses(entry.descripcion);
    const answeredPendingQuantity = isQuantityQuestion(saved.question) && pendingMasses.length === 1;
    let items = applyExplicitGrams(Array.isArray(result?.items) ? result.items : [], entry.descripcion, answeredPendingQuantity);
    if (result) result.items = items;
    const getReplyIssues = () => [
      ...(!['new', 'append', 'update'].includes(result?.action) ? ['action'] : []),
      ...(!Array.isArray(result?.items) ? ['items'] : []),
      ...(!Object.hasOwn(result || {}, 'clarificationQuestion') || result.clarificationQuestion != null && typeof result.clarificationQuestion !== 'string' ? ['clarificationQuestion'] : []),
      ...items.flatMap((item, index) => foodItemIssues(item).map((issue) => `items[${index}].${issue}`)),
      ...(answeredPendingQuantity && (!items.length || items.some((item) => item.quantityGrams == null)) ? ['quantityGrams'] : []),
    ];
    let replyIssues = getReplyIssues();
    for (let attempt = 1; attempt <= 1 && (replyIssues.length || (!items.length && !result?.clarificationQuestion)); attempt++) {
      traceFoodSession(trace, 'reply_validation_retry', { issueCount: replyIssues.length || 1, attempt });
      parts = await withFoodSessionLock(userId, () => requestFoodDescription({
        ...requestArgs, sessionId, description: modelDescription,
        retryFeedback: `ÚNICO REINTENTO: corrige la respuesta completa en JSON según estos problemas: ${replyIssues.length ? replyIssues.join(', ') : 'JSON ausente o ilegible'}. Mantén el formato y los alimentos pendientes del contexto. Si ya respondieron una cantidad, refleja el valor convertido a gramos en quantityGrams y recalcula macros; no vuelvas a preguntar lo ya contestado. No inventes datos; pregunta solo por la información que aún falte.`,
      }));
      stage = 'parse';
      result = parseReply(parts);
      items = applyExplicitGrams(Array.isArray(result?.items) ? result.items : [], entry.descripcion, answeredPendingQuantity);
      if (result) result.items = items;
      replyIssues = getReplyIssues();
      if (replyIssues.length || (!items.length && !result?.clarificationQuestion)) {
        stage = 'validation';
        traceFoodSession(trace, 'reply_validation_failed', { stage, errorCode: 'FOOD_RESPONSE_INVALID_STRUCTURE', issueCount: replyIssues.length || 1, retries: attempt });
        throw Object.assign(new Error('OpenCode no devolvió un formato válido tras un reintento. No se guardaron los alimentos; vuelve a enviar el mensaje.'), { code: 'FOOD_RESPONSE_INVALID_STRUCTURE' });
      }
    }
    const assistantMessages = Array.isArray(result?.assistantMessages)
      ? result.assistantMessages.filter((message) => typeof message === 'string' && message.trim()
        && !/(?:a cu[aá]l comida|qu[eé] comida|which meal|no hay comidas guardadas|no existe una comida)/i.test(message)).map((message) => message.slice(0, 5000))
      : [];
    let clarification = result?.clarificationQuestion;
    if (isQuantityQuestion(saved.question) && pendingMasses.length > 1 && items.some((item) => item.quantityGrams == null)) {
      const names = pendingFoodItems.filter((item) => item.quantityGrams == null).map((item) => item.name).join(', ');
      clarification = `Mencionaste varias cantidades (${pendingMasses.join(' g, ')} g). Indica cuál corresponde a cada alimento${names ? `: ${names}` : ''}, por ejemplo “lentejas 150g”.`;
    }
    if (answeredPendingQuantity && isQuantityQuestion(clarification) && items.length && items.every((item) => item.quantityGrams != null)) clarification = null;
    const createsNew = result.action === 'new';
    let effectiveTime = requestedTime && !requestedTime.invalid && (!activeTarget || createsNew) ? requestedTime : null;
    if (asksDayChoice && dayChoice === 'anterior') effectiveTime = requestedTime;
    if (asksPreviousDayConfirmation && previousSaveAnswer?.confirmed) effectiveTime = previousSaveAnswer.time;
    let timeClarification = requestedTime?.invalid ? 'No pude interpretar la hora. Indícala como 2:02 p. m. o 14:02.' : null;
    if (!activeTarget && requestedTime?.ambiguous && matchedMeals.length !== 1) {
      const label = `${requestedTime.hours[0] % 12 || 12}${requestedTime.precision === 'minute' ? `:${String(requestedTime.minute).padStart(2, '0')}` : ''}`;
      timeClarification = `¿Te refieres a las ${label} a. m. o p. m.?`;
      effectiveTime = null;
    }
    if (!activeTarget && matchedMeals.length > 1 && !timeClarification
      && (result.action === 'update' || requestedTime && !requestedTime.invalid)) {
      timeClarification = `Hay varias comidas${requestedTime ? ' a esa hora' : ' guardadas este día'}. ¿A cuál deseas ${result.action === 'update' ? 'corregir' : 'agregar alimentos'}? ${matchedMeals.map((meal) => `${meal.hora}: ${(meal.alimentos || []).join(', ') || meal.descripcion}`).join('; ')}`;
    }
    if (!requestedTime && !activeTarget && result.action !== 'update' && clarification && /(?:a qu[eé] hora|hora.*consumiste|cu[aá]ndo.*comida)/i.test(clarification)) clarification = null;
    if (result.action !== 'update' && clarification && /(?:a cu[aá]l comida|qu[eé] comida|which meal|no hay comidas guardadas|no existe una comida)/i.test(clarification)) clarification = null;
    let selectedMeal = matchedMeals.length === 1 ? matchedMeals[0] : null;
    if (matchedMeals.length > 1 && result.targetEntryId != null) {
      selectedMeal = matchedMeals.find((meal) => String(meal.id) === String(result.targetEntryId)) || null;
      if (selectedMeal) timeClarification = null;
    }
    if (timeClarification) clarification = [timeClarification, clarification].filter(Boolean).join(' ');
    let appendTargetId = null;
    let updateTargetId = null;
    if (!clarification && activeTarget) {
      if (result.action === 'append') appendTargetId = activeTarget.id;
      else if (result.action === 'update') updateTargetId = activeTarget.id;
      else if (!createsNew) clarification = '¿Quieres agregar alimentos a esta comida o corregir un alimento existente?';
    } else if (!clarification && result.action === 'update') {
      updateTargetId = selectedMeal?.id || null;
      if (updateTargetId == null) clarification = 'No pude identificar una sola comida guardada para corregir. Indica cuál por alimento, hora o fecha.';
    } else if (!clarification && !timeClarification && (requestedTime && !requestedTime.invalid || pendingTarget)) {
      appendTargetId = selectedMeal?.id || null;
    }
    const targetEntryId = updateTargetId || appendTargetId;
    const target = targetEntryId == null ? null : matchedMeals.find((meal) => String(meal.id) === String(targetEntryId));
    const ownedTarget = target && await dbQuery(`SELECT id FROM registros_comidas WHERE id=${target.id} AND usuario_id=${userId} AND fecha_consumo=${textSql(entry.fecha)} AND estado='completado' LIMIT 1;`);
    if (targetEntryId != null && !ownedTarget) { appendTargetId = null; updateTargetId = null; clarification = 'La comida seleccionada ya no está disponible. Indica cuál quieres modificar.'; }
    const asksMacroRepair = /\b(?:recalcul(?:a|ar|en)|complet(?:a|ar|en)|rellen(?:a|ar|en)|faltan|falta)\b.{0,60}\bmacros?\b|\bmacros?\b.{0,60}\b(?:faltantes?|incompletos?|recalcular)\b/i.test(entry.descripcion);
    const asksCorrection = asksMacroRepair || /\b(corrige|corregir|actualiza|actualizar|reemplaza|reemplazar|cambia|cambiar)\b/i.test(entry.descripcion);
    const asksAddition = /\b(agrega|agregar|añade|añadir|incorpora|incorporar)\b/i.test(entry.descripcion);
    if (asksMacroRepair && result.action !== 'update') {
      clarification = matchedMeals.length === 1
        ? `No pude identificar los alimentos que necesitan macros en la comida de las ${matchedMeals[0].hora}. Indica cuáles quieres completar.`
        : `No pude identificar una sola comida para completar macros. Indica cuál: ${matchedMeals.map((meal) => `${meal.hora}: ${(meal.alimentos || []).join(', ') || meal.descripcion}`).join('; ') || 'no hay comidas completadas disponibles'}.`;
    }
    if (activeTarget && !clarification && asksCorrection && !asksAddition && result.action !== 'update') {
      appendTargetId = null;
      updateTargetId = null;
      clarification = 'Para corregir, indica qué alimento guardado quieres actualizar y la cantidad correcta.';
    } else if (activeTarget && !clarification && asksAddition && !asksCorrection && ['update', 'new'].includes(result.action)) {
      if (items.some((item) => item.targetItemId != null)) clarification = 'Elige si quieres agregar alimentos o corregir uno ya guardado.';
      else { updateTargetId = null; appendTargetId = activeTarget.id; }
    }
    const retainedTargetId = updateTargetId || appendTargetId || (activeTarget && (!createsNew || asksCorrection && !asksAddition) ? activeTarget.id : null);
    if (updateTargetId != null) {
      const availableItemIds = new Set((target?.items || []).map((item) => String(item.targetItemId)));
      if (!items.some((item) => item.targetItemId != null) || items.some((item) => item.targetItemId != null && !availableItemIds.has(String(item.targetItemId)))) {
        const availableItems = (target?.items || []).map((item) => `${item.name}${item.quantity ? ` (${item.quantity})` : ''}`).join('; ');
        clarification = availableItems
          ? `No pude identificar cuál alimento corregir. Los alimentos guardados en esa comida son: ${availableItems}. Indica cuál y la cantidad correcta.`
          : 'No encontré alimentos guardados en esa comida. Indica cuál registro quieres corregir.';
        updateTargetId = null;
      }
    } else if (items.some((item) => item.targetItemId != null)) {
      clarification = 'No pude vincular la corrección a una comida activa. Vuelve a indicar cuál registro quieres ajustar.';
    }
    if ((asksDayChoice && dayChoice === 'anterior') || (asksPreviousDayConfirmation && previousSaveAnswer?.confirmed)) {
      appendTargetId = null;
      updateTargetId = null;
    }
    traceFoodSession(trace, 'food_destination_resolved', { explicitTime: Boolean(requestedTime && !requestedTime.invalid), resumedTarget: Boolean(activeTarget), candidateCount: matchedMeals.length, appended: Boolean(appendTargetId), updated: Boolean(updateTargetId) });
    let createdAt = null;
    let savedDate = entry.fecha;
    let savedDescription = asksDayChoice || asksPreviousDayConfirmation ? saved.description : entry.descripcion;
    const isEarlyTime = requestedTime && !requestedTime.invalid && requestedTime.hours.length === 1
      && requestedTime.hours[0] * 60 + requestedTime.minute >= 1 && requestedTime.hours[0] * 60 + requestedTime.minute <= 300;
    if (asksDayChoice && !dayChoice) clarification = '¿Esta comida pertenece al día nutricional seleccionado o al anterior? Responde “actual” o “anterior”.';
    if (isEarlyTime && !asksDayChoice && !asksPreviousDayConfirmation && !activeTarget) {
      clarification = `¿Esta comida pertenece al día nutricional seleccionado (${entry.fecha}) o al anterior (${previousDate(entry.fecha)})?`;
    }
    if (asksDayChoice && dayChoice === 'anterior') {
      clarification = `¿La guardo en el día nutricional anterior (${previousDate(entry.fecha)})? Sugiero dejarla a las 11:59:59 p. m. para mantenerla dentro de esa fecha. Confirma o indica otra hora.`;
    }
    if (asksPreviousDayConfirmation && !previousSaveAnswer?.confirmed) {
      clarification = `¿La guardo en el día nutricional anterior (${previousDate(entry.fecha)})? Sugiero dejarla a las 11:59:59 p. m. para mantenerla dentro de esa fecha. Confirma o indica otra hora.`;
    }
    if (asksPreviousDayConfirmation && previousSaveAnswer?.confirmed) {
      savedDate = confirmedDate || previousDate(entry.fecha);
      savedDescription += ' [Se guardó explícitamente en la fecha calendario anterior.]';
    }
    if (effectiveTime && appendTargetId == null) {
      const hour = effectiveTime.hours.length === 1 ? effectiveTime.hours[0] : null;
      const usePreviousDayTime = asksPreviousDayConfirmation && previousSaveAnswer?.confirmed;
      const calendarDate = usePreviousDayTime ? savedDate : entry.fecha;
      createdAt = usePreviousDayTime
        ? localDateTimeToUtc(calendarDate, effectiveTime.hours[0], effectiveTime.minute, entry.timezone)?.replace(/:00$/, previousSaveAnswer.lastSecond ? ':59' : ':00')
        : hour == null ? null : localDateTimeToUtc(calendarDate, hour, effectiveTime.minute, entry.timezone);
      if (!createdAt) clarification = [clarification, 'Esa hora no existe en la fecha seleccionada por el cambio de horario. Confirma una hora válida.'].filter(Boolean).join(' ');
    }
    const itemIssues = items.map(foodItemIssues);
    const invalidItems = clarification ? 0 : itemIssues.filter((issues) => issues.length).length;
    if (!clarification && !invalidItems && items.some((item) => item.quantityGrams == null)) {
      const names = items.filter((item) => item.quantityGrams == null).map((item) => item.name).join(', ');
      clarification = `¿Cuántos gramos aproximadamente consumiste de ${names}?`;
    }
    if (!clarification && !items.length && !invalidItems) clarification = '¿Cuántos gramos aproximadamente consumiste de cada alimento?';
    stage = 'validation';
    const invalidClarification = clarification != null && (typeof clarification !== 'string' || clarification.length > 5000);
    const validationCode = !items.length && !clarification ? 'FOOD_RESPONSE_NO_ITEMS'
      : invalidItems ? 'FOOD_RESPONSE_INVALID_ITEMS'
        : invalidClarification ? 'FOOD_RESPONSE_INVALID_CLARIFICATION' : null;
    if (validationCode) {
      traceFoodSession(trace, 'reply_validation_failed', {
        stage, errorCode: validationCode, itemCount: items.length, invalidItemCount: invalidItems,
        hasClarification: Boolean(clarification), invalidClarification,
      });
      throw Object.assign(new Error('La respuesta del análisis no pasó la validación de alimentos.'), { code: validationCode });
    }
    traceFoodSession(trace, 'reply_validated', { itemCount: items.length, invalidItemCount: invalidItems, hasClarification: Boolean(clarification) });
    stage = 'persistence';
    if (clarification) {
      const question = clarification.slice(0, 5000);
      const clarificationTargetId = retainedTargetId;
      const destination = clarificationTargetId == null ? 'NULL' : clarificationTargetId;
      const createdAtUpdate = createdAt ? `,creado_en=${textSql(createdAt)}` : '';
      const statements = ["SET time_zone='+00:00'", 'START TRANSACTION', `DELETE FROM registros_comida_items WHERE registro_comida_id=${entryId}`, `UPDATE registros_comidas SET estado='borrador_chat',registro_comida_destino_id=${destination},pregunta_pendiente=${textSql(question)}${createdAtUpdate},energia_kcal=NULL,energia_449_kcal=NULL,proteina_g=NULL,carbohidratos_g=NULL,grasa_g=NULL,fibra_g=NULL WHERE id=${entryId} AND usuario_id=${userId}`];
      for (const message of assistantMessages) if (message !== question) statements.push(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${entryId},'assistant',${textSql(message)})`);
      if (!assistantMessages.includes(question)) statements.push(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${entryId},'assistant',${textSql(question)})`);
      statements.push(resolveNotificationsSql({ userId, category: 'comida', textSql }));
      if (!suppressNotification) statements.push(notificationInsertSql({ userId, category: 'comida', state: 'requiere_respuesta', title: 'Comida: falta una aclaración', message: question, referenceId: entryId, textSql }));
      statements.push('COMMIT');
      await dbQuery(`${statements.join(';')};`);
      for (const item of items) {
        if (foodItemIssues(item).length) continue;
        try {
          await dbQuery(`${pendingFoodItemSql(entryId, item, textSql)};`);
        } catch (error) {
          traceFoodSession(trace, 'draft_candidate_persistence_failed', { stage: 'persistence', errorCode: safeOpenCodeErrorCode(error) });
          try { await recordFoodError({ dbQuery, textSql, userId, trace, stage: 'persistence', error }); }
          catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
        }
      }
      const messages = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`);
      json(response, 200, { state: 'requiere_aclaracion', entryId, requestId: entry.requestId, targetEntryId: clarificationTargetId, question, messages: messages ? messages.split(/\r?\n/).map((row) => JSON.parse(row)) : [], message: question });
      return;
    }
    if (!items.length) throw new Error('El asistente no devolvió alimentos para completar el registro.');
    const append = appendTargetId != null;
    const updating = updateTargetId != null;
    const destinationId = updating ? updateTargetId : append ? appendTargetId : entryId;
    const targetMeal = destinationId === entryId ? null : dayMeals.find((meal) => String(meal.id) === String(destinationId));
    const estimatedItems = items.filter((item) => item.macroStatus === 'estimado').length;
    const confirmation = (updating
      ? `Se corrigieron alimentos de la comida de las ${targetMeal?.hora || 'la hora seleccionada'}.`
      : append ? `Alimentos añadidos a la comida de las ${targetMeal?.hora || 'la hora seleccionada'}.`
      : `Registro completado: ${items.length} alimento${items.length === 1 ? '' : 's'} guardado${items.length === 1 ? '' : 's'}${createdAt && effectiveTime ? ` a las ${formatFoodTime(effectiveTime.hours[0], effectiveTime.minute)}` : ''}.`)
      + (estimatedItems ? ` Incluye ${estimatedItems} alimento${estimatedItems === 1 ? '' : 's'} con macros estimados.` : '');
    let draftMessages = [];
    if (append || updating) {
      const messages = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`);
      draftMessages = messages ? messages.split(/\r?\n/).map((row) => JSON.parse(row)).filter((message) => !isLegacyFoodNameError(message) && !isFoodErrorMessage(message) && !isFoodIdentityRefusal(message)) : [];
    }
    const statements = ["SET time_zone='+00:00'", 'START TRANSACTION', `DELETE FROM registros_comida_items WHERE registro_comida_id=${entryId}`];
    for (const item of items) {
      const factor = item.macroBasis === 'per_100g' ? item.quantityGrams / 100 : 1;
      const m = Object.fromEntries(Object.entries(item.macros).map(([key, value]) => [key, value * factor]));
      const quantity = String(item.quantityGrams);
      const energy449 = 4 * m.proteinG + 4 * m.carbohydrateG + 9 * m.fatG;
      const source = item.macroSource;
      const method = item.macroSource === 'webfetch' ? 'webfetch' : item.macroSource === 'opencode_estimado' ? 'opencode_estimado' : 'declarado_usuario';
      const quantityText = item.quantityText || `${item.quantityGrams} g`;
      const webName = item.macroSource === 'webfetch' ? textSql(item.sourceName) : 'NULL';
      const webUrl = item.macroSource === 'webfetch' ? textSql(item.sourceUrl) : 'NULL';
      const webQuote = item.macroSource === 'webfetch' ? textSql(item.sourceQuote) : 'NULL';
      const values = `${textSql(item.sourceText)},${textSql(item.name.trim())},${webName},${webUrl},${webQuote},${textSql(quantityText)},${quantity},${textSql(source)},${textSql(method)},'per_portion',${textSql(item.macroStatus)},${m.energyKcal},${energy449},${m.proteinG},${m.carbohydrateG},${m.fatG},${m.fiberG}`;
      if (updating && item.targetItemId != null) statements.push(`UPDATE registros_comida_items SET fragmento_original=${textSql(item.sourceText)},nombre_alimento=${textSql(item.name.trim())},nombre_fuente_web=${webName},url_fuente_web=${webUrl},cita_fuente=${webQuote},cantidad_texto=${textSql(quantityText)},cantidad_g=${quantity},fuente_macros=${textSql(source)},metodo_energia=${textSql(method)},base_macros='per_portion',estado_macros=${textSql(item.macroStatus)},energia_kcal=${m.energyKcal},energia_449_kcal=${energy449},proteina_g=${m.proteinG},carbohidratos_g=${m.carbohydrateG},grasa_g=${m.fatG},fibra_g=${m.fiberG} WHERE id=${item.targetItemId} AND registro_comida_id=${destinationId}`);
      else statements.push(`INSERT INTO registros_comida_items(registro_comida_id,fragmento_original,nombre_alimento,nombre_fuente_web,url_fuente_web,cita_fuente,cantidad_texto,cantidad_g,fuente_macros,metodo_energia,base_macros,estado_macros,energia_kcal,energia_449_kcal,proteina_g,carbohidratos_g,grasa_g,fibra_g) VALUES (${destinationId},${values})`);
    }
    const total = (column) => `(SELECT IF(COUNT(*)=SUM(base_macros='per_portion'),SUM(${column}),NULL) FROM registros_comida_items WHERE registro_comida_id=${destinationId})`;
    if (append || updating) {
      for (const message of draftMessages) statements.push(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${destinationId},${textSql(message.role)},${textSql(message.content)})`);
      for (const message of assistantMessages) statements.push(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${destinationId},'assistant',${textSql(message)})`);
      statements.push(`UPDATE registros_comidas SET estado='completado',pregunta_pendiente=NULL,energia_kcal=${total('energia_kcal')},energia_449_kcal=${total('energia_449_kcal')},proteina_g=${total('proteina_g')},carbohidratos_g=${total('carbohidratos_g')},grasa_g=${total('grasa_g')},fibra_g=${total('fibra_g')} WHERE id=${destinationId} AND usuario_id=${userId}`, `INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido,request_id) VALUES (${destinationId},'assistant',${textSql(confirmation)},${textSql(entry.requestId)})`, `DELETE FROM registros_comidas WHERE id=${entryId} AND usuario_id=${userId}`);
    } else {
      for (const message of assistantMessages) statements.push(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${entryId},'assistant',${textSql(message)})`);
      statements.push(`UPDATE registros_comidas SET estado='completado',registro_comida_destino_id=NULL,pregunta_pendiente=NULL,fecha_consumo=${textSql(savedDate)},descripcion_original=${textSql(savedDescription)}${createdAt ? `,creado_en=${textSql(createdAt)}` : ''},energia_kcal=${total('energia_kcal')},energia_449_kcal=${total('energia_449_kcal')},proteina_g=${total('proteina_g')},carbohidratos_g=${total('carbohidratos_g')},grasa_g=${total('grasa_g')},fibra_g=${total('fibra_g')} WHERE id=${entryId} AND usuario_id=${userId}`, `INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) VALUES (${entryId},'assistant',${textSql(confirmation)})`);
    }
    statements.push(resolveNotificationsSql({ userId, category: 'comida', textSql }));
    if (!suppressNotification) statements.push(notificationInsertSql({ userId, category: 'comida', state: 'guardado', title: 'Comida guardada', message: confirmation, referenceId: append || updating ? destinationId : entryId, textSql }));
    statements.push(`DELETE old FROM registros_comida_interacciones old JOIN (SELECT registro_comida_id,MIN(CASE WHEN role='user' THEN id END) first_user_id,MAX(CASE WHEN role='user' THEN id END) last_user_id,MAX(CASE WHEN role='assistant' THEN id END) last_assistant_id FROM registros_comida_interacciones WHERE registro_comida_id=${destinationId} GROUP BY registro_comida_id) retained ON retained.registro_comida_id=old.registro_comida_id WHERE old.id NOT IN (retained.first_user_id,retained.last_user_id,retained.last_assistant_id)`);
    statements.push('COMMIT');
    await dbQuery(`${statements.join(';')};`);
    committed = true;
    committedEntryId = destinationId;
    committedConfirmation = confirmation;
    traceFoodSession(trace, 'items_saved', { itemCount: items.length, appended: append });
    const messages = append || updating
      ? await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${destinationId} ORDER BY id;`).then((rows) => rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [])
      : await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`).then((rows) => rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : []);
    stage = 'verification';
    const records = await readFoodEntries({ userId, fecha: savedDate, dbQuery, textSql });
    const persisted = records.find((record) => String(record.id) === String(destinationId) && record.state === 'completado');
    const expectedItemCount = append ? (target?.items.length || 0) + items.length
      : updating ? (target?.items.length || 0) + items.filter((item) => item.targetItemId == null).length : items.length;
    const missingUpdatedItems = items.filter((item) => item.targetItemId != null)
      .some((item) => !persisted?.items.some((savedItem) => String(savedItem.itemId) === String(item.targetItemId)));
    if (!persisted || persisted.items.length !== expectedItemCount || missingUpdatedItems) {
      throw Object.assign(new Error('food_entry_readback_mismatch'), { code: 'FOOD_PERSISTENCE_VERIFY_FAILED' });
    }
    traceFoodSession(trace, 'persistence_verified', { entryId: destinationId, itemCount: persisted.items.length });
    try {
      await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
    }
    catch (error) {
      traceFoodSession(trace, 'session_cleanup_failed', {
        errorCode: safeOpenCodeErrorCode(error),
        ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { upstreamHttpStatus: error.status } : {}),
        ...(typeof error.operation === 'string' ? { operation: error.operation } : {}),
      });
      try { await recordFoodError({ dbQuery, textSql, userId, trace, stage: 'session_cleanup', error }); }
      catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
    }
    json(response, 200, { state: 'completado', entryId: append || updating ? destinationId : entryId, fecha: savedDate, requestId: entry.requestId, appended: append, updated: updating, records, messages: Array.isArray(messages) ? messages : [], message: confirmation });
  } catch (error) {
    traceFoodSession(trace, 'save_failed', { entryId: entryId || null, stage, errorCode: safeOpenCodeErrorCode(error) });
    try { await recordFoodError({ dbQuery, textSql, userId, trace, stage, error, httpStatus: entryId ? 502 : 503 }); }
    catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
    if (committed) {
      json(response, 503, { state: 'completado', entryId: committedEntryId, requestId: entry.requestId, message: `${committedConfirmation} No pude verificar la lectura actualizada. Actualiza el día antes de volver a enviar la solicitud.` });
      return;
    }
    if (entryId && /^\d+$/.test(entryId)) {
      const message = error.code === 'FOOD_IDENTITY_REFUSAL' ? 'Se renovó la sesión para continuar el análisis sin pedir tu identidad; vuelve a enviar el alimento.'
        : stage === 'persistence' ? 'El análisis terminó, pero no se pudieron guardar sus alimentos y macros.'
        : ['parse', 'validation'].includes(stage) ? 'El asistente respondió, pero sus datos de alimentos o macros no tenían un formato válido.'
          : 'El borrador quedó guardado, pero el asistente no completó el análisis. Puedes intentarlo de nuevo.';
      try { await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'assistant', content: `[ERROR_REGISTRO] ${message}` }); } catch {}
      if (!suppressNotification) try { await dbQuery(`${notificationInsertSql({ userId, category: 'comida', state: 'error', title: 'No se pudo completar el registro de comida', message, referenceId: entryId, textSql })};`); } catch {}
      json(response, 502, { entryId, requestId: entry.requestId, message });
      return;
    }
    json(response, 503, { error: 'No se pudo iniciar el registro de comida.' });
  }
}

module.exports = { applyExplicitGrams, deleteFoodEntry, foodItemIssues, localDateTimeToUtc, normalizeFoodReply, parseFoodReply, parseFoodTime, readFoodEntries, readPendingFoodDraft, saveFoodEntry, validateFoodEntry, validFoodItem };
