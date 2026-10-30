const { randomUUID } = require('node:crypto');
const { deleteFoodOpenCodeSession, ensureFoodOpenCodeSession, findOpenFoodFactsProduct, findUsdaFood, maxFoodResponseWaitMs, recordFoodError, requestFoodDescription, safeOpenCodeErrorCode, traceFoodSession, withFoodSessionLock } = require('./opencode-food.js');
const { notificationInsertSql, resolveNotificationsSql } = require('./notifications.js');
const { createAnalysisProgressRecorder } = require('./analysis-progress.js');
const foodProgress = new Map();

function getFoodEntryProgress(userId, requestId) {
  const key = `${userId}:${requestId}`;
  const progress = foodProgress.get(key);
  if (progress && Date.now() - progress.updatedAt > 15 * 60 * 1000) foodProgress.delete(key);
  return foodProgress.get(key) || null;
}

function reportFoodProgress(userId, requestId, event, details = {}, recordEvent) {
  recordEvent?.(event);
  const labels = {
    save_received: 'Validando solicitud…', entry_saved: 'Borrador guardado; preparando análisis…',
    session_resolution_started: 'Preparando sesión de análisis…', session_ready: 'Separando alimentos y cantidades…',
    message_sent: 'Analizando los alimentos…', message_received: 'Respuesta recibida; revisando alimentos…',
    openfoodfacts_lookup_started: 'Consultando Open Food Facts…', usda_lookup_started: 'Consultando USDA…',
    known_foods_reused: 'Reutilizando alimentos ya registrados…', web_resolution_started: 'Buscando y verificando una fuente…', reply_validation_retry: 'Validando macros; reintentando análisis…',
    reply_validated: 'Macros validados; guardando comida…', items_saved: 'Alimentos guardados; verificando registro…',
    persistence_verified: 'Registro verificado.', save_failed: 'El análisis se detuvo; se conserva el borrador.',
  };
  let label = labels[event];
  if (event === 'food_sources_lookup') label = `Consultas terminadas: Open Food Facts ${details.openFoodFactsMatched}/${details.queried}; USDA ${details.usdaMatched}/${details.usdaQueried}.`;
  if (!label) return;
  const key = `${userId}:${requestId}`;
  foodProgress.set(key, { label, updatedAt: Date.now() });
  if (foodProgress.size > 500) foodProgress.delete(foodProgress.keys().next().value);
}

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

function parseFoodReferenceTime(text) {
  const normalized = String(text).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, '');
  const match = /\b(?:como|igual(?:\s+que)?|el mismo|la misma|mismo|misma)\b.{0,60}?\b(?:de\s+)?(?:a\s+)?las?\s+(\d{1,2}(?::\d{2})?(?:\s*(?:am|pm|a\s*m|p\s*m|de la manana|de la tarde|de la noche))?)\b/i.exec(normalized);
  if (!match) return null;
  const value = match[1].trim();
  const start = match.index + match[0].lastIndexOf(match[1]);
  return { time: parseFoodTime(/(?:am|pm|a\s*m|p\s*m|de la manana|de la tarde|de la noche)$/.test(value) ? value : `a las ${value}`), withoutReferenceTime: `${normalized.slice(0, start)} ${normalized.slice(start + match[1].length)}`.replace(/\s+/g, ' ').trim() };
}

function applyFoodMacroReferences(items, referenceItems) {
  return items.map((item) => {
    const sameName = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    const matches = referenceItems.filter((candidate) => sameName(candidate.name) === sameName(item.name));
    const signature = (candidate) => JSON.stringify(['quantityGrams', 'energyKcal', 'proteinG', 'carbohydrateG', 'fatG', 'fiberG', 'macroStatus', 'macroSource', 'sourceName', 'sourceUrl', 'sourceQuote'].map((key) => candidate[key] ?? null));
    const ambiguousSource = matches.length > 1 && matches.some((candidate) => signature(candidate) !== signature(matches[0]));
    const source = ambiguousSource ? null : item.referenceItemId == null ? matches[0]
      : matches.find((candidate) => String(candidate.itemId ?? candidate.targetItemId) === String(item.referenceItemId));
    const sourceGrams = Number(source?.quantityGrams);
    const quantityGrams = Number(item.quantityGrams);
    const completeMacros = source && ['energyKcal', 'proteinG', 'carbohydrateG', 'fatG'].every((key) => source[key] != null && Number.isFinite(Number(source[key])));
    if (!completeMacros || !source || sameName(item.name) !== sameName(source.name) || !Number.isFinite(sourceGrams) || sourceGrams <= 0) return item;
    const reference = { ...item, referenceItemId: String(source.itemId ?? source.targetItemId), referenceSourceMatched: true };
    if (!Number.isFinite(quantityGrams) || quantityGrams <= 0) return reference;
    const factor = quantityGrams / sourceGrams;
    return {
      ...reference, referenceMacrosReused: true,
      name: source.name, macroBasis: 'per_portion', macroStatus: source.macroStatus,
      macroSource: source.macroSource, sourceName: source.sourceName, sourceUrl: source.sourceUrl,
      sourceQuote: source.sourceQuote,
      macros: Object.fromEntries(['energyKcal', 'proteinG', 'carbohydrateG', 'fatG', 'fiberG'].map((key) => [key, source[key] == null ? null : Math.round((Number(source[key]) * factor + Number.EPSILON) * 100) / 100])),
    };
  });
}

function applyOpenFoodFactsMacros(items, products) {
  return items.map((item) => {
    const product = products.find((candidate) => candidate.name === item.name);
    return product && item.targetItemId == null && item.macroSource !== 'declarado_usuario' && !hasExplicitVolume(item) ? { ...item, ...product } : item;
  });
}

function formatFoodTime(hour, minute) {
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}

function isEarlyNutritionHour(minutes) { return Number.isInteger(minutes) && minutes >= 0 && minutes < 240; }
function needsSelectedNutritionDateConfirmation(selectedDate, localDate, minutes) {
  return isEarlyNutritionHour(minutes) && selectedDate !== localDate;
}

function previousDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function localNutritionDateTime(timezone, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute), now };
}

function isSelectedNutritionDateQuestion(question) {
  return /^¿Confirmas registrar esta comida en el día nutricional seleccionado \(\d{4}-\d{2}-\d{2}\)\?/i.test(String(question || ''));
}

function selectedNutritionDateAnswer(question, answer) {
  if (!isSelectedNutritionDateQuestion(question)) return null;
  const text = String(answer || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\./g, '').trim();
  const affirmative = /^(?:si|confirmo|correcto|de acuerdo|claro|adelante)(?:\b|$)/.test(text);
  const negative = /^(?:no|cambiar|cancela|cancelar)(?:\b|$)/.test(text);
  const time = parseFoodTime(answer);
  const timeOnly = /^\s*(?:(?:a\s+las?\s+)|(?:la\s+hora\s+es\s+))?\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:am|pm|a\s*m|p\s*m|de la manana|de la tarde|de la noche)?\s*$/i.test(text);
  const mentionsTime = timeOnly || /\b(?:hora|a las?|am|pm|manana|tarde|noche)\b/.test(text);
  if (negative) return { confirmed: false, declined: true };
  if (mentionsTime) {
    if (time && !time.invalid && !time.ambiguous && time.hours.length === 1) {
      return { confirmed: true, time, lastSecond: /(?:23:59:59|11:59:59\s*(?:p\s*m|pm))/.test(text) };
    }
    return { confirmed: false, declined: false };
  }
  if (!affirmative) return { confirmed: false, declined: false };
  const suggestedLastSecond = /sugiero las 11:59:59 p\. m\./i.test(String(question));
  return { confirmed: true, time: suggestedLastSecond ? { hours: [23], minute: 59 } : null, lastSecond: suggestedLastSecond };
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
  const rows = await dbQuery(`SET time_zone='+00:00';
SELECT 'records';
SELECT JSON_OBJECT('id',e.id,'fecha',DATE_FORMAT(e.fecha_consumo,'%Y-%m-%d'),'createdAt',DATE_FORMAT(e.creado_en,'%Y-%m-%dT%H:%i:%sZ'),'state',e.estado,'description',e.descripcion_original) FROM registros_comidas e WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} AND e.estado<>'borrador_chat' ORDER BY e.creado_en,e.id LIMIT 100;
SELECT 'items';
SELECT JSON_OBJECT('entryId',i.registro_comida_id,'itemId',CAST(i.id AS CHAR),'sourceText',i.fragmento_original,'name',i.nombre_alimento,'quantity',i.cantidad_texto,'quantityGrams',i.cantidad_g,'basis',i.base_macros,'energyKcal',i.energia_kcal,'proteinG',i.proteina_g,'carbohydrateG',i.carbohidratos_g,'fatG',i.grasa_g,'fiberG',i.fibra_g,'macroStatus',i.estado_macros,'macroSource',i.fuente_macros,'sourceName',i.nombre_fuente_web,'sourceUrl',i.url_fuente_web,'sourceQuote',i.cita_fuente) FROM registros_comida_items i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} ORDER BY e.creado_en,e.id,i.id;
SELECT 'clarifications';
SELECT JSON_OBJECT('entryId',i.registro_comida_id,'content',i.contenido) FROM registros_comida_interacciones i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND e.fecha_consumo=${textSql(date)} AND e.estado='completado' AND i.role='user' AND i.id>(SELECT MIN(firstTurn.id) FROM registros_comida_interacciones firstTurn WHERE firstTurn.registro_comida_id=i.registro_comida_id AND firstTurn.role='user') ORDER BY i.registro_comida_id,i.id;`);
  const sections = { records: [], items: [], clarifications: [] };
  let section = '';
  for (const row of rows.split(/\r?\n/).filter(Boolean)) {
    if (Object.hasOwn(sections, row)) section = row;
    else if (section) sections[section].push(row);
  }
  const records = sections.records.map((row) => ({ ...JSON.parse(row), items: [], clarifications: [] }));
  if (!records.length) return records;
  const byEntry = new Map(records.map((record) => [String(record.id), record.items]));
  for (const row of sections.items) {
    const item = JSON.parse(row);
    byEntry.get(String(item.entryId))?.push(item);
  }
  const byClarificationEntry = new Map(records.map((record) => [String(record.id), record.clarifications]));
  for (const row of sections.clarifications) {
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

async function readFoodConversationText({ entryId, dbQuery, fallback, excludeLatestUser = false, messages: provided }) {
  const messages = [...(provided ?? await readFoodConversationMessages({ entryId, dbQuery }))];
  if (excludeLatestUser && messages.at(-1)?.role === 'user') messages.pop();
  return messages.map((message) => `${message.role === 'user' ? 'Usuario' : 'Asistente'}: ${message.content}`).join('\n') || fallback;
}

async function readFoodConversationMessages({ entryId, dbQuery }) {
  const rows = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)).filter((message) => !isLegacyFoodNameError(message) && !isFoodErrorMessage(message) && !isFoodIdentityRefusal(message)) : [];
}

function hasGenericEstimateApproval(messages, pendingQuestion, answer) {
  if (/\b(?:aceptas|acepta|usar|estimaci[oó]n)\b.{0,100}\bgen[eé]ric[oa]s?\b/i.test(pendingQuestion || '')
    && /^\s*(?:s[ií]|correcto|de acuerdo|adelante)\b/i.test(answer || '')) return true;
  let approved = false;
  let genericQuestionPending = false;
  for (const message of messages) {
    if (message.role === 'assistant') {
      genericQuestionPending = /\b(?:aceptas|acepta|usar|estimaci[oó]n)\b.{0,100}\bgen[eé]ric[oa]s?\b/i.test(message.content);
    } else if (message.role === 'user') {
      if (/\b(?:no quiero|no uses|no acepto)\b.{0,40}\bgen[eé]ric[oa]s?\b|\b(?:prefiero|mejor busca)\b.{0,40}\b(?:marca|etiqueta)\b/i.test(message.content)) approved = false;
      else if (/^\s*(?:(?:usa|usar|quiero|acepto|puedes usar)\s+)?gen[eé]ric[oa]s?\s*[.!]?\s*$|\b(?:usa|usar|quiero|acepto|puedes usar|prefiero)\b.{0,50}\bgen[eé]ric[oa]s?\b|\bno tengo (?:la )?etiqueta\b|\bsin (?:la )?etiqueta\b/i.test(message.content)
        || genericQuestionPending && /^\s*(?:s[ií]|correcto|de acuerdo|adelante)\b/i.test(message.content)) approved = true;
      genericQuestionPending = false;
    }
  }
  return approved;
}

async function readDraftFoodItems({ entryId, userId, dbQuery }) {
  const rows = await dbQuery(`SELECT JSON_OBJECT('sourceText',i.fragmento_original,'name',i.nombre_alimento,'quantityText',i.cantidad_texto,'quantityGrams',i.cantidad_g,'macroBasis',i.base_macros,'macroStatus',i.estado_macros,'macroSource',i.fuente_macros,'sourceName',i.nombre_fuente_web,'sourceUrl',i.url_fuente_web,'sourceQuote',i.cita_fuente,'macros',JSON_OBJECT('energyKcal',i.energia_kcal,'proteinG',i.proteina_g,'carbohydrateG',i.carbohidratos_g,'fatG',i.grasa_g,'fiberG',i.fibra_g)) FROM registros_comida_items i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.id=${entryId} AND e.usuario_id=${userId} AND e.estado='borrador_chat' ORDER BY i.id;`);
  return rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : [];
}

async function saveFoodInteraction({ dbQuery, textSql, entryId, role, content }) {
  const text = content.slice(0, 5000);
  await dbQuery(`INSERT INTO registros_comida_interacciones(registro_comida_id,role,contenido) SELECT ${entryId},${textSql(role)},${textSql(text)} FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM (SELECT role,contenido FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id DESC LIMIT 1) AS last WHERE last.role=${textSql(role)} AND BINARY last.contenido=BINARY ${textSql(text)});`);
}

async function deleteFoodEntry({ userId, entryId, dbQuery }) {
  if (!/^\d+$/.test(String(userId)) || !/^[1-9]\d*$/.test(String(entryId))) throw Object.assign(new Error('Registro no válido.'), { status: 400 });
  const result = await dbQuery(`DELETE FROM registros_comidas WHERE id=${entryId} AND usuario_id=${userId}; SELECT ROW_COUNT();`);
  return result.split(/\s+/).at(-1) === '1';
}

async function clearFoodChatHistory({ userId, requestId, targetEntryId, dbQuery, textSql }) {
  if (!/^\d+$/.test(String(userId)) || requestId != null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)
      || targetEntryId != null && !/^[1-9]\d*$/.test(String(targetEntryId))) throw Object.assign(new Error('El contexto de conversación no es válido.'), { status: 400 });
  const statements = ["SET time_zone='+00:00'", 'START TRANSACTION'];
  if (requestId) statements.push(`DELETE FROM registros_comidas WHERE usuario_id=${userId} AND request_id=${textSql(requestId)} AND estado='borrador_chat'`);
  if (targetEntryId != null) statements.push(`DELETE i FROM registros_comida_interacciones i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.id=${targetEntryId} AND e.usuario_id=${userId} AND e.estado='completado'`);
  statements.push('COMMIT');
  await dbQuery(`${statements.join(';')};`);
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
  const statuses = { pendiente: 'pendiente', pending: 'pendiente', estimado: 'estimado', estimated: 'estimado', opencode_estimado: 'estimado', opencode_estimated: 'estimado', declared: 'declarado', declarado: 'declarado', declarado_usuario: 'declarado', verified: 'declarado', verificado: 'declarado' };
  const sources = { pendiente: 'pendiente', pending: 'pendiente', webfetch: 'webfetch', web: 'webfetch', internet: 'webfetch', usda: 'webfetch', declarado_usuario: 'declarado_usuario', declared: 'declarado_usuario', user: 'declarado_usuario', opencode_estimado: 'opencode_estimado', estimated: 'opencode_estimado' };
  const actions = { new: 'new', nueva: 'new', append: 'append', agregar: 'append', anexar: 'append', append_to_existing: 'append', add_to_existing: 'append', update: 'update', actualizar: 'update', corregir: 'update', correction: 'update' };
  const action = actions[String(reply.action || '').toLowerCase()] || null;
  const target = reply.targetEntryId ?? reply.target_entry_id;
  const number = (value) => {
    if (typeof value !== 'string' || !value.trim()) return value;
    const text = value.trim().replace(',', '.');
    return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ? Number(text) : Number.NaN;
  };
  return { ...reply, items: reply.items.map((item) => {
    const quantityGrams = number(item?.quantityGrams);
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
      macros: item?.macros && Object.fromEntries(['energyKcal', 'proteinG', 'carbohydrateG', 'fatG', 'fiberG'].map((key) => [key, number(item.macros[key])])),
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
  if (hasExplicitVolume(item) && item.macroBasis !== 'per_portion') issues.push('volume_requires_per_portion');
  const referenceGrams = Number.isFinite(item?.quantityGrams) && item.quantityGrams > 0 ? item.quantityGrams : item?.macroBasis === 'per_100g' ? 100 : null;
  if (macros && referenceGrams != null
      && ['proteinG', 'carbohydrateG', 'fatG', 'fiberG'].some((key) => macros[key] != null
        && macros[key] * (item.macroBasis === 'per_100g' && Number.isFinite(item.quantityGrams) ? item.quantityGrams / 100 : 1) > referenceGrams * 1.05)) issues.push('macro_unit_bounds');
  const factor = item?.macroBasis === 'per_100g' && Number.isFinite(item.quantityGrams) ? item.quantityGrams / 100 : 1;
  const energy = macros?.energyKcal * factor;
  if (referenceGrams != null && Number.isFinite(energy) && energy > referenceGrams * 9.5) issues.push('energy_unit_bounds');
  if (macros && Number.isFinite(macros.energyKcal)
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

function parseDeclaredFoodLine(description) {
  const [name, quantityText, macroText, ...extra] = String(description || '').split('|').map((part) => part.trim());
  const quantity = quantityText?.match(/^cantidad consumida:\s*(\d+(?:[.,]\d+)?)\s*g$/i);
  const parts = macroText?.split(';').map((part) => part.trim()) || [];
  const number = '(\\d+(?:[.,]\\d+)?)';
  const read = (index, label) => {
    const match = parts[index]?.match(new RegExp(`^${number}\\s*(?:g\\s*)?${label}$`, 'i'));
    return match ? Number(match[1].replace(',', '.')) : null;
  };
  if (extra.length || !name || name.length > 150 || !quantity || parts.length < 4 || parts.length > 5) return null;
  const grams = Number(quantity[1].replace(',', '.'));
  const energyKcal = read(0, 'kcal');
  const proteinG = read(1, '(?:g\\s*)?(?:prote[ií]nas?|protein)');
  const carbohydrateG = read(2, '(?:g\\s*)?(?:carbohidratos?|hidratos(?:\\s+de\\s+carbono)?|carbs?)');
  const fatG = read(3, '(?:g\\s*)?(?:grasas?|fat)');
  const fiberG = parts.length === 5 ? read(4, '(?:g\\s*)?(?:fibras?|fiber)') : null;
  if (![grams, energyKcal, proteinG, carbohydrateG, fatG].every(Number.isFinite) || grams <= 0 || grams > 9999999.999 || parts.length === 5 && fiberG == null) return null;
  const item = {
    sourceText: `${quantity[1]} g de ${name}`, name, quantityGrams: grams, quantityText: `${grams} g`,
    macroBasis: 'per_portion', macroStatus: 'declarado', macroSource: 'declarado_usuario',
    sourceName: null, sourceUrl: null, sourceQuote: null,
    macros: { energyKcal, proteinG, carbohydrateG, fatG, fiberG },
  };
  return foodItemIssues(item).length ? null : item;
}

function parseDeclaredFoodShortcut(description) {
  const lines = String(description || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 12) return null;
  const items = lines.map(parseDeclaredFoodLine);
  return items.every(Boolean) ? { action: 'new', targetEntryId: null, items, clarificationQuestion: null } : null;
}

function usedFoodWebTools(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === 'tool'
    && /web[\s_-]?(?:search|fetch)|search the web|fetch webpage/i.test(`${part.tool || ''} ${part.state?.title || ''}`));
}

function usedFoodWebFetch(parts) {
  return Array.isArray(parts) && parts.some((part) => part?.type === 'tool'
    && /web[\s_-]?fetch|fetch webpage/i.test(`${part.tool || ''} ${part.state?.title || ''}`));
}

function explicitFoodMasses(description) {
  return [...new Set([...String(description).matchAll(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(kg|kilogramos?|gr|g|gramos?)\b/gi)]
    .map((match) => Number(match[1].replace(',', '.')) * (/^(?:kg|kilogramos?)$/i.test(match[2]) ? 1000 : 1))
    .filter((grams) => Number.isFinite(grams) && grams > 0 && grams <= 9999999.999))];
}

function hasExplicitVolume(item) {
  return item?.quantityGrams == null && typeof item?.quantityText === 'string'
    && /\b(?:\d+(?:[.,]\d+)?|un(?:a|o)?|dos|tres|cuatro|cinco)\s*(?:ml|millilitros?|cucharaditas?|cditas?|cucharadas?|cdas?|pizcas?|tazas?|vasos?|puñados?|piezas?|rebanadas?|cucharones?)\b/i.test(item.quantityText);
}

function explicitFoodMeasures(descriptions) {
  const measures = [];
  for (const text of Array.isArray(descriptions) ? descriptions : [descriptions]) {
    for (const segment of String(text || '').split(/[,;]|\b(?:y|e|and)\b/i)) {
      for (const match of segment.matchAll(/(?:^|[^\d])(\d+(?:[.,]\d+)?)\s*(kg|kilogramos?|gr|g|gramos?|ml|mililitros?)\b/gi)) {
        const value = Number(match[1].replace(',', '.'));
        const unit = match[2].toLowerCase();
        const context = segment.replace(/^\s*(?:usuario|asistente):\s*/i, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
        if (Number.isFinite(value) && value > 0) measures.push({ value, unit, segment: context });
      }
    }
  }
  return [...new Map(measures.map((measure) => [`${measure.value}:${measure.unit}:${measure.segment}`, measure])).values()];
}

function applyExplicitQuantities(items, descriptions, allowUniqueMass = false) {
  const measures = explicitFoodMeasures(descriptions);
  const terms = (value) => new Set(String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2));
  const measureGroups = [...new Map(measures.map((measure) => [`${measure.value}:${measure.unit}`, { ...measure, contexts: measures.filter((candidate) => candidate.value === measure.value && candidate.unit === measure.unit).map(({ segment }) => segment) }])).values()];
  for (const item of items) {
    if (!item || item.quantityGrams != null || hasExplicitVolume(item)) continue;
    const directMass = explicitFoodMasses(item.quantityText);
    if (directMass.length === 1) { item.quantityGrams = directMass[0]; continue; }
    const nameTerms = terms(item.name);
    const sourceTerms = terms(item.sourceText);
    const matches = measureGroups.map((measure) => ({ ...measure, score: Math.max(...measure.contexts.map((context) => {
      const contextTerms = terms(context);
      const nameScore = [...contextTerms].filter((word) => nameTerms.has(word)).length;
      return nameScore || [...contextTerms].filter((word) => sourceTerms.has(word)).length;
    })) }))
      .filter((measure) => measure.score > 0).sort((a, b) => b.score - a.score);
    const best = matches[0];
    if (best && (!matches[1] || best.score > matches[1].score)) {
      if (/^(?:ml|mililitros?)$/.test(best.unit)) item.quantityText = `${best.value} ml`;
      else {
        item.quantityGrams = best.value * (/^(?:kg|kilogramos?)$/.test(best.unit) ? 1000 : 1);
        item.quantityText = `${item.quantityGrams} g`;
      }
    } else if (allowUniqueMass && items.filter((candidate) => candidate?.quantityGrams == null && !hasExplicitVolume(candidate)).length === 1) {
      const masses = [...new Set(measures.filter((measure) => /^(?:kg|kilogramos?|gr|g|gramos?)$/.test(measure.unit)).map((measure) => measure.value * (/^(?:kg|kilogramos?)$/.test(measure.unit) ? 1000 : 1)))];
      if (masses.length === 1) { item.quantityGrams = masses[0]; item.quantityText = `${masses[0]} g`; }
    }
  }
  return items;
}

function applyExplicitGrams(items, description, allowUniqueMissing = false) {
  const pending = items.filter((item) => item?.quantityGrams == null);
  const masses = [...new Set(explicitFoodMasses(description))];
  if ((items.length === 1 || allowUniqueMissing && pending.length === 1) && pending.length === 1 && masses.length === 1) {
    pending[0].quantityGrams = masses[0];
    pending[0].quantityText ||= `${masses[0]} g`;
    return items;
  }
  return applyExplicitQuantities(items, description, allowUniqueMissing);
}

function isQuantityQuestion(text) {
  return /(?:cu[aá]ntos?\s+(?:gramos?|mililitros?)|cantidad\s+en\s+(?:gramos?|mililitros?)|qu[eé]\s+cantidad|peso aproximado)/i.test(String(text || ''));
}

function pendingFoodItemSql(entryId, item, textSql) {
  const macros = item.macros;
  const value = (field) => field == null ? 'NULL' : textSql(field);
  const energy449 = 4 * macros.proteinG + 4 * macros.carbohydrateG + 9 * macros.fatG;
  const method = item.macroSource === 'webfetch' ? 'webfetch' : item.macroSource === 'opencode_estimado' ? 'opencode_estimado' : 'declarado_usuario';
  const fields = [entryId, textSql(item.sourceText), textSql(item.name.trim()), value(item.sourceName), value(item.sourceUrl), value(item.sourceQuote), value(item.quantityText), item.quantityGrams == null ? 'NULL' : item.quantityGrams, textSql(item.macroSource), textSql(method), textSql(item.macroBasis), textSql(item.macroStatus), macros.energyKcal, energy449, macros.proteinG, macros.carbohydrateG, macros.fatG, macros.fiberG == null ? 'NULL' : macros.fiberG];
  return `INSERT INTO registros_comida_items(registro_comida_id,fragmento_original,nombre_alimento,nombre_fuente_web,url_fuente_web,cita_fuente,cantidad_texto,cantidad_g,fuente_macros,metodo_energia,base_macros,estado_macros,energia_kcal,energia_449_kcal,proteina_g,carbohidratos_g,grasa_g,fibra_g) VALUES (${fields.join(',')})`;
}

const foodKey = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

async function readKnownFoods({ userId, names, dbQuery, textSql }) {
  const unique = [...new Set((names || []).map((name) => String(name || '').trim()).filter((name) => name && name.length <= 150))].slice(0, 12);
  const known = new Map();
  if (!unique.length) return known;
  const rows = await dbQuery(`SELECT JSON_OBJECT('name',i.nombre_alimento,'grams',i.cantidad_g,'macroStatus',i.estado_macros,'macroSource',i.fuente_macros,'sourceName',i.nombre_fuente_web,'sourceUrl',i.url_fuente_web,'sourceQuote',i.cita_fuente,'energyKcal',i.energia_kcal,'proteinG',i.proteina_g,'carbohydrateG',i.carbohidratos_g,'fatG',i.grasa_g,'fiberG',i.fibra_g) FROM registros_comida_items i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND e.estado='completado' AND i.base_macros='per_portion' AND i.cantidad_g>0 AND i.energia_kcal IS NOT NULL AND i.nombre_alimento IN (${unique.map(textSql).join(',')}) ORDER BY e.creado_en DESC,i.id DESC LIMIT 200;`);
  for (const row of rows ? rows.split(/\r?\n/).filter(Boolean) : []) {
    let food;
    try { food = JSON.parse(row); } catch { continue; }
    const key = foodKey(food.name);
    const grams = Number(food.grams);
    if (known.has(key) || !['declarado_usuario', 'webfetch', 'opencode_estimado'].includes(food.macroSource) || !Number.isFinite(grams) || grams <= 0) continue;
    const value = (field) => field == null ? null : Number(field);
    known.set(key, {
      name: food.name, grams, macroStatus: food.macroStatus, macroSource: food.macroSource,
      sourceName: food.sourceName, sourceUrl: food.sourceUrl, sourceQuote: food.sourceQuote,
      macros: { energyKcal: value(food.energyKcal), proteinG: value(food.proteinG), carbohydrateG: value(food.carbohydrateG), fatG: value(food.fatG), fiberG: value(food.fiberG) },
    });
  }
  return known;
}

function scaleKnownMacros(food, factor, decimals) {
  const round = 10 ** decimals;
  return Object.fromEntries(Object.entries(food.macros).map(([key, value]) => [key, value == null ? null : Math.round(value * factor * round) / round]));
}

function knownFoodProduct(food, name) {
  return {
    name, macroBasis: 'per_100g', macroStatus: food.macroStatus, macroSource: food.macroSource,
    sourceName: food.sourceName, sourceUrl: food.sourceUrl, sourceQuote: food.sourceQuote,
    macros: scaleKnownMacros(food, 100 / food.grams, 4),
  };
}

async function knownFoodsShortcut({ description, userId, dbQuery, textSql }) {
  const segments = String(description || '').split(/\r?\n|;|,|\s+y\s+|\+/i).map((part) => part.trim()).filter(Boolean);
  if (!segments.length || segments.length > 12) return null;
  const parsed = segments.map((segment) => segment.match(/^(.{1,150}?)\s+(\d+(?:[.,]\d+)?)\s*(?:g|gr|grs|gramos?)\.?$/i));
  if (parsed.some((match) => !match)) return null;
  const known = await readKnownFoods({ userId, names: parsed.map((match) => match[1]), dbQuery, textSql });
  const items = [];
  for (const [, rawName, rawGrams] of parsed) {
    const food = known.get(foodKey(rawName));
    const grams = Number(rawGrams.replace(',', '.'));
    if (!food || !(grams > 0)) return null;
    items.push({
      sourceText: `${rawGrams} g de ${food.name}`, name: food.name, quantityGrams: grams, quantityText: `${grams} g`,
      macroBasis: 'per_portion', macroStatus: food.macroStatus, macroSource: food.macroSource,
      sourceName: food.sourceName, sourceUrl: food.sourceUrl, sourceQuote: food.sourceQuote,
      macros: scaleKnownMacros(food, grams / food.grams, 2),
    });
  }
  return items.every((item) => !foodItemIssues(item).length) ? { action: 'new', targetEntryId: null, items, clarificationQuestion: null } : null;
}

function repairEstimatedEnergy(items) {
  return items.map((item) => {
    const macros = item?.macros;
    if (item?.macroSource !== 'opencode_estimado' || !macros || !['proteinG', 'carbohydrateG', 'fatG'].every((key) => Number.isFinite(macros[key]) && macros[key] >= 0)) return item;
    const expected = Math.round((4 * macros.proteinG + 4 * macros.carbohydrateG + 9 * macros.fatG) * 10) / 10;
    const consistent = Number.isFinite(macros.energyKcal) && Math.abs(macros.energyKcal - expected) <= Math.max(25, macros.energyKcal * 0.25, (macros.fiberG || 0) * 2);
    return consistent ? item : { ...item, macros: { ...macros, energyKcal: expected } };
  });
}

async function saveFoodEntry({ response, data, userId, dbQuery, textSql, json, requestOpenCode, now = () => new Date() }) {
  const suppressNotification = data?.suppressNotification === true;
  if (!/^\d+$/.test(String(userId))) { json(response, 400, { error: 'Cuenta no válida.' }); return; }
  let entry;
  try { entry = validateFoodEntry(data); }
  catch (error) { json(response, error.status || 400, { error: error.message }); return; }

  const trace = { id: randomUUID(), events: [] };
  const progressRecorder = createAnalysisProgressRecorder({ dbQuery, textSql, userId, flow: 'comida', operationId: entry.requestId });
  trace.onEvent = (event, details) => reportFoodProgress(userId, entry.requestId, event, details, progressRecorder.record);
  traceFoodSession(trace, 'save_received');
  let entryId;
  let committed = false;
  let committedEntryId;
  let committedConfirmation;
  let stage = 'draft';
  try {
    const initial = { timezone: '', draftDate: '', prior: '' };
    let initialSection = '';
    for (const row of (await dbQuery(`SELECT 'timezone';
SELECT zona_horaria FROM preferencias_usuario WHERE usuario_id=${userId} LIMIT 1;
SELECT 'draftDate';
SELECT DATE_FORMAT(fecha_consumo,'%Y-%m-%d') FROM registros_comidas WHERE usuario_id=${userId} AND request_id=${textSql(entry.requestId)} AND estado='borrador_chat' LIMIT 1;
SELECT 'prior';
SELECT JSON_OBJECT('entryId',e.id,'fecha',DATE_FORMAT(e.fecha_consumo,'%Y-%m-%d')) FROM registros_comida_interacciones i JOIN registros_comidas e ON e.id=i.registro_comida_id WHERE e.usuario_id=${userId} AND i.request_id=${textSql(entry.requestId)} LIMIT 1;`)).split(/\r?\n/).filter(Boolean)) {
      if (Object.hasOwn(initial, row)) initialSection = row;
      else if (initialSection) initial[initialSection] = row;
    }
    if (initial.timezone) entry.timezone = initial.timezone;
    const existingDraftDate = initial.draftDate;
    const appended = initial.prior;
    if (existingDraftDate) entry.fecha = existingDraftDate;
    if (appended) {
      const prior = JSON.parse(appended);
      await progressRecorder.flush();
      json(response, 200, { state: 'completado', entryId: prior.entryId, records: await readFoodEntries({ userId, fecha: prior.fecha, dbQuery, textSql }), message: 'Los alimentos ya se habían añadido a esa comida.' });
      return;
    }
    if (entry.targetEntryId && !await dbQuery(`SELECT id FROM registros_comidas WHERE id=${entry.targetEntryId} AND usuario_id=${userId} AND fecha_consumo=${textSql(entry.fecha)} AND estado='completado' LIMIT 1;`)) {
      json(response, 404, { error: 'La comida que quieres ajustar ya no está disponible.' });
      return;
    }
    const [insertedId, savedRow] = (await dbQuery(`INSERT INTO registros_comidas(usuario_id,registro_comida_destino_id,request_id,fecha_consumo,descripcion_original,estado,creado_en) VALUES (${userId},${entry.targetEntryId || 'NULL'},${textSql(entry.requestId)},${textSql(entry.fecha)},${textSql(entry.descripcion)},'borrador_chat',CURRENT_TIMESTAMP(3)) AS incoming ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id);
SELECT LAST_INSERT_ID();
SELECT JSON_OBJECT('state',estado,'fecha',DATE_FORMAT(fecha_consumo,'%Y-%m-%d'),'description',descripcion_original,'question',pregunta_pendiente,'targetEntryId',registro_comida_destino_id) FROM registros_comidas WHERE id=LAST_INSERT_ID() AND usuario_id=${userId} LIMIT 1;`)).split(/\r?\n/);
    entryId = String(insertedId || '').trim();
    if (!/^\d+$/.test(entryId)) throw new Error('food_entry_insert_failed');
    traceFoodSession(trace, 'entry_saved', { entryId });

    const saved = JSON.parse(savedRow);
    if (saved.state === 'completado') {
      json(response, 200, { state: 'completado', entryId, records: await readFoodEntries({ userId, fecha: saved.fecha, dbQuery, textSql }), message: 'Esta comida ya estaba guardada.' });
      return;
    }
    if (saved.fecha !== entry.fecha) throw Object.assign(new Error('La fecha del borrador no coincide.'), { status: 409 });

    const identityRefusal = isFoodIdentityRefusal({ role: 'assistant', content: saved.question });
    if (['borrador_chat', 'requiere_aclaracion'].includes(saved.state) && saved.question && !isLegacyFoodNameError({ role: 'assistant', content: saved.question }) && !identityRefusal) {
      const existingMessages = await readFoodConversationMessages({ entryId, dbQuery });
      if (!existingMessages.some((message) => message.role === 'user' && message.content === saved.description)) {
        await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'user', content: saved.description });
      }
      if (!existingMessages.some((message) => message.role === 'assistant' && message.content === saved.question)) {
        await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'assistant', content: saved.question });
      }
    }
    await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'user', content: entry.descripcion });
    const localNow = localNutritionDateTime(entry.timezone, now());
    const localClockMinutes = localNow.minutes;
    const asksSelectedDateConfirmation = isSelectedNutritionDateQuestion(saved.question);
    const selectedDateAnswer = asksSelectedDateConfirmation ? selectedNutritionDateAnswer(saved.question, entry.descripcion) : null;
    const correctionIntent = /\b(corrige|corregir|actualiza|actualizar|reemplaza|reemplazar|cambia|cambiar)\b/i.test(entry.descripcion)
      || /\b(?:complet(?:a|ar|en)|recalcul(?:a|ar|en))\b.{0,60}\bmacros?\b|\bmacros?\b.{0,60}\b(?:faltantes?|incompletos?|recalcular)\b/i.test(entry.descripcion);
    const returnDayClarification = async (question) => {
      await dbQuery(`UPDATE registros_comidas SET estado='borrador_chat',pregunta_pendiente=${textSql(question)} WHERE id=${entryId} AND usuario_id=${userId} AND estado='borrador_chat';`);
      await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'assistant', content: question });
      await dbQuery(`${resolveNotificationsSql({ userId, category: 'comida', textSql })}${suppressNotification ? '' : `;${notificationInsertSql({ userId, category: 'comida', state: 'requiere_respuesta', title: 'Comida: confirma el día seleccionado', message: question, referenceId: entryId, textSql })}`};`);
      const messages = await dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${entryId} ORDER BY id;`);
      json(response, 200, { state: 'requiere_aclaracion', entryId, requestId: entry.requestId, targetEntryId: entry.targetEntryId, question, messages: messages ? messages.split(/\r?\n/).map((row) => JSON.parse(row)) : [], message: question });
    };
    if (asksSelectedDateConfirmation && !selectedDateAnswer?.confirmed) {
      if (selectedDateAnswer?.declined) {
        await dbQuery(`DELETE FROM registros_comidas WHERE id=${entryId} AND usuario_id=${userId} AND estado='borrador_chat';`);
        await progressRecorder.flush();
        json(response, 200, { state: 'cancelado', entryId, requestId: entry.requestId, message: 'Registro cancelado; no se guardó la comida.' });
        return;
      }
      await returnDayClarification(saved.question);
      return;
    }
    if (needsSelectedNutritionDateConfirmation(entry.fecha, localNow.date, localClockMinutes)
      && !entry.targetEntryId && !saved.targetEntryId && !correctionIntent) {
      const selectedDateLabel = new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${entry.fecha}T12:00:00Z`));
      const currentDateLabel = new Intl.DateTimeFormat('es-MX', { timeZone: entry.timezone, day: 'numeric', month: 'long', year: 'numeric' }).format(localNow.now);
      const currentTimeLabel = new Intl.DateTimeFormat('es-MX', { timeZone: entry.timezone, hour: 'numeric', minute: '2-digit' }).format(localNow.now);
      const suggestion = entry.fecha === previousDate(localNow.date)
        ? ' Para agregarla al balance de ese día, sugiero las 11:59:59 p. m.; confirma o indica otra hora. La fecha seleccionada determina dónde se suman los macros.'
        : ' Confirma para agregarla y sumar sus macros al balance del día seleccionado; puedes indicar otra hora.';
      const question = `Ahora son las ${currentTimeLabel} del ${currentDateLabel} y está seleccionado el día ${selectedDateLabel}. ¿Confirmas registrar esta comida en el día nutricional seleccionado (${entry.fecha})?${suggestion}`;
      await returnDayClarification(question);
      return;
    }
    const pendingFoodItems = saved.question ? await readDraftFoodItems({ entryId, userId, dbQuery }) : [];
    let conversationMessages;
    const readConversation = () => conversationMessages ??= readFoodConversationMessages({ entryId, dbQuery });
    const genericEstimateApproved = hasGenericEstimateApproval(await readConversation(), saved.question, entry.descripcion);
    const asksTimeChoice = /Hay varias comidas a esa hora|¿Te refieres a las .*a\. m\. o p\. m\./i.test(saved.question || '');
    const priorUserText = asksTimeChoice || asksSelectedDateConfirmation ? (await readConversation()).filter((message) => message.role === 'user').map((message) => message.content).join('\n') : '';
    const parsedFoodReference = parseFoodReferenceTime(entry.descripcion) || parseFoodReferenceTime(saved.description);
    const foodReference = parsedFoodReference?.time && !parsedFoodReference.time.invalid ? parsedFoodReference : null;
    const requestedTime = parseFoodTime(foodReference?.withoutReferenceTime || entry.descripcion) || (priorUserText ? parseFoodTime(priorUserText) : null);
    const asksAddition = /\b(agrega|agregar|añade|añadir|incorpora|incorporar)\b/i.test(entry.descripcion);
    const reuseAsNewMeal = Boolean(foodReference) && !correctionIntent && !asksAddition;
    let modelDescription = asksSelectedDateConfirmation && selectedDateAnswer?.confirmed ? saved.description : entry.descripcion;
    const conversation = await readFoodConversationText({ entryId, dbQuery, fallback: '', excludeLatestUser: true, messages: await readConversation() });
    const fastPathAllowed = !saved.question && !conversation && !genericEstimateApproved && !reuseAsNewMeal
      && !correctionIntent && !asksAddition && entry.targetEntryId == null && !requestedTime && !foodReference
      && !isEarlyNutritionHour(localClockMinutes);
    const directFastPath = fastPathAllowed
      ? parseDeclaredFoodShortcut(modelDescription) || await knownFoodsShortcut({ description: modelDescription, userId, dbQuery, textSql })
      : null;
    const dayMeals = directFastPath ? [] : (await readFoodEntries({ userId, fecha: entry.fecha, dbQuery, textSql })).filter((record) => record.state === 'completado').map((record) => {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: entry.timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(record.createdAt)).map(({ type, value }) => [type, value]));
      return {
        id: String(record.id), hora: new Intl.DateTimeFormat('es-MX', { timeZone: entry.timezone, hour: '2-digit', minute: '2-digit' }).format(new Date(record.createdAt)),
        hour24: Number(parts.hour), minute: Number(parts.minute),
        alimentos: record.items.map((item) => `${item.name}${item.quantity ? ` (${item.quantity})` : ''}`),
        items: record.items.map(({ itemId, sourceText, name, quantity, quantityGrams, basis, energyKcal, proteinG, carbohydrateG, fatG, fiberG, macroStatus, macroSource, sourceName, sourceUrl, sourceQuote }) => ({ targetItemId: String(itemId), sourceText, name, quantity, quantityGrams, basis, energyKcal, proteinG, carbohydrateG, fatG, fiberG, macroStatus, macroSource, sourceName, sourceUrl, sourceQuote })),
        ...(record.items.length ? {} : { descripcion: record.description }),
      };
    });
    const referenceMeals = foodReference?.time && !foodReference.time.invalid
      ? dayMeals.filter((meal) => foodReference.time.hours.includes(meal.hour24) && (foodReference.time.precision === 'hour' || foodReference.time.minute === meal.minute))
      : [];
    const referenceItems = referenceMeals.flatMap((meal) => meal.items);
    const continuationTarget = entry.targetEntryId == null ? null : dayMeals.find((meal) => String(meal.id) === String(entry.targetEntryId));
    const pendingTarget = !requestedTime && saved.question && saved.targetEntryId != null
      ? dayMeals.find((meal) => String(meal.id) === String(saved.targetEntryId))
      : null;
    const activeTarget = continuationTarget || pendingTarget;
    const matchedMeals = activeTarget ? [activeTarget] : requestedTime && !requestedTime.invalid
      ? dayMeals.filter((meal) => requestedTime.hours.includes(meal.hour24) && (requestedTime.precision === 'hour' || requestedTime.minute === meal.minute))
      : dayMeals;
    if (requestedTime?.ambiguous && matchedMeals.length === 1) requestedTime.hours = [matchedMeals[0].hour24];
    const needsFullMeals = Boolean(saved.question || correctionIntent || asksAddition || requestedTime || foodReference || activeTarget);
    const mealsForModel = needsFullMeals ? matchedMeals : matchedMeals.map((meal) => ({
      ...meal, items: meal.items.map(({ targetItemId, name, quantity, quantityGrams }) => ({ targetItemId, name, quantity, quantityGrams })),
    }));
    const parseReply = (responseParts) => {
      try { return normalizeFoodReply(parseFoodReply(responseParts)); }
      catch (error) { if (error.code === 'FOOD_IDENTITY_REFUSAL') throw error; return null; }
    };
    let openFoodFactsProducts = [];
    const quantityContext = [saved.description, conversation, entry.descripcion].filter(Boolean);
    const pendingMasses = [...new Set(quantityContext.flatMap(explicitFoodMasses))];
    const answeredPendingQuantity = isQuantityQuestion(saved.question) && pendingMasses.length === 1;
    const directReply = directFastPath;
    const openFoodFactsFirstPass = !directReply && !saved.question && !genericEstimateApproved && !reuseAsNewMeal && !correctionIntent && !activeTarget;
    let requestArgs;
    let sessionId;
    let analysisDeadline;
    let result = directReply;
    let webSearchUsed = false;
    let webFetchUsed = false;
    const requestFoodWithSessionRecovery = async (args) => {
      const send = (options = {}) => withFoodSessionLock(userId, () => requestFoodDescription({
        ...args, ...options, sessionId, deadline: analysisDeadline, trace, requestOpenCode,
      }));
      try { return await send(); }
      catch (error) {
        if (error.status !== 404) throw error;
        const previousStage = stage;
        stage = 'session_recovery';
        traceFoodSession(trace, 'session_recovery_started', { stage, errorCode: safeOpenCodeErrorCode(error), upstreamHttpStatus: error.status });
        try {
          await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
          const renewed = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode, trace, returnMetadata: true });
          sessionId = renewed.sessionId;
          const conversation = await readFoodConversationText({ entryId, dbQuery, fallback: '', excludeLatestUser: true, messages: await readConversation() });
          const parts = await send({ conversation: conversation || args.conversation || undefined });
          stage = previousStage;
          traceFoodSession(trace, 'session_recovery_succeeded', { stage: previousStage });
          return parts;
        } catch (recoveryError) {
          traceFoodSession(trace, 'session_recovery_failed', {
            stage, errorCode: safeOpenCodeErrorCode(recoveryError),
            ...(Number.isInteger(recoveryError.status) ? { upstreamHttpStatus: recoveryError.status } : {}),
          });
          throw recoveryError;
        }
      }
    };
    if (directReply) {
      traceFoodSession(trace, 'declared_food_fast_path', { itemCount: directReply.items.length });
    } else {
      if (identityRefusal) {
        await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
        traceFoodSession(trace, 'identity_refusal_session_reset');
      }
      stage = 'session_resolution';
      const session = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode, trace, returnMetadata: true });
      sessionId = session.sessionId;
      stage = 'analysis';
      analysisDeadline = Date.now() + maxFoodResponseWaitMs;
      requestArgs = { sessionId, description: modelDescription, initialDescription: saved.description, genericEstimateApproved, allowWebSearch: Boolean(saved.question || correctionIntent || activeTarget), openFoodFactsFirstPass, ...(reuseAsNewMeal ? { referenciaComidaSolicitada: true } : {}), ...(!session.reused && conversation ? { conversation } : {}), comidasDisponibles: mealsForModel, ...(reuseAsNewMeal && referenceMeals.length ? { comidasReferencia: referenceMeals } : {}), alimentosPendientes: pendingFoodItems, continuacionRegistro: Boolean(activeTarget), diaNutricional: entry.fecha, trace, requestOpenCode };
      let parts = await requestFoodWithSessionRecovery(requestArgs);
      webSearchUsed = usedFoodWebTools(parts);
      webFetchUsed = usedFoodWebFetch(parts);
      stage = 'parse';
      try { result = parseReply(parts); }
      catch (error) {
        traceFoodSession(trace, 'reply_parse_failed', { partTypes: parts.map((part) => part.type) });
        if (error.code !== 'FOOD_IDENTITY_REFUSAL') throw error;
        modelDescription = await readFoodConversationText({ entryId, dbQuery, fallback: entry.descripcion, messages: await readConversation() });
        await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode, forgetOnError: true });
        traceFoodSession(trace, 'identity_refusal_session_reset');
        const renewed = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode, trace, returnMetadata: true });
        sessionId = renewed.sessionId;
        if (conversation) requestArgs.conversation = conversation;
        parts = await requestFoodWithSessionRecovery({ ...requestArgs, description: modelDescription });
        webSearchUsed ||= usedFoodWebTools(parts);
        webFetchUsed ||= usedFoodWebFetch(parts);
        result = parseReply(parts);
      }
    }
    if (result?.items?.length) result.items = applyExplicitQuantities(result.items, quantityContext, answeredPendingQuantity);
    if (result?.items?.length && openFoodFactsFirstPass) {
      const names = [...new Set(result.items.filter((item) => item.targetItemId == null && item.macroSource !== 'declarado_usuario' && !hasExplicitVolume(item)).map((item) => item.name).filter(Boolean))];
      const known = await readKnownFoods({ userId, names, dbQuery, textSql });
      const knownNames = names.filter((name) => known.has(foodKey(name)));
      if (knownNames.length) {
        traceFoodSession(trace, 'known_foods_reused', { itemCount: knownNames.length });
        openFoodFactsProducts.push(...knownNames.map((name) => knownFoodProduct(known.get(foodKey(name)), name)));
      }
      const lookupNames = names.filter((name) => !known.has(foodKey(name)));
      const usdaProducts = [];
      const offProducts = [];
      let usdaQueried = 0;
      if (lookupNames.length) {
        traceFoodSession(trace, 'openfoodfacts_lookup_started', { itemCount: lookupNames.length });
        const queue = [...lookupNames];
        await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
          for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
            const product = await findOpenFoodFactsProduct(name);
            if (product) { offProducts.push(product); continue; }
            if (!usdaQueried++) traceFoodSession(trace, 'usda_lookup_started');
            const usda = await findUsdaFood(name);
            if (usda) usdaProducts.push(usda);
          }
        }));
        openFoodFactsProducts.push(...offProducts, ...usdaProducts);
        traceFoodSession(trace, 'food_sources_lookup', {
          queried: lookupNames.length, openFoodFactsMatched: offProducts.length,
          usdaQueried, usdaMatched: usdaProducts.length,
        });
      }
      const needsSource = (item) => item.targetItemId == null && item.macroSource !== 'declarado_usuario' && (hasExplicitVolume(item) || !openFoodFactsProducts.some((product) => product.name === item.name));
      const unresolved = result.items.some(needsSource);
      if (unresolved) {
        requestArgs.allowWebSearch = true;
        requestArgs.openFoodFactsFirstPass = false;
        requestArgs.openFoodFactsCandidates = openFoodFactsProducts;
        traceFoodSession(trace, 'web_resolution_started', { unresolvedCount: result.items.filter(needsSource).length });
        parts = await requestFoodWithSessionRecovery({
          ...requestArgs, retryFeedback: 'Primero se consultó Open Food Facts. Usa sus candidatos solo si el producto coincide exactamente; conserva esos macros y su procedencia sin sustituirlos. Usa websearch/webfetch únicamente para los alimentos que no tengan candidato coincidente. No inventes ni cambies productos.',
        });
        webSearchUsed ||= usedFoodWebTools(parts);
        webFetchUsed ||= usedFoodWebFetch(parts);
        stage = 'parse';
        result = parseReply(parts);
      }
    } else if (openFoodFactsFirstPass && !result?.clarificationQuestion) {
      requestArgs.allowWebSearch = true;
      requestArgs.openFoodFactsFirstPass = false;
    }
    if (reuseAsNewMeal && result) { result.action = 'new'; result.targetEntryId = null; }
    let items = repairEstimatedEnergy(applyOpenFoodFactsMacros(applyFoodMacroReferences(applyExplicitQuantities(Array.isArray(result?.items) ? result.items : [], quantityContext, answeredPendingQuantity), referenceItems), openFoodFactsProducts));
    if (result) result.items = items;
    const getReplyIssues = () => [
      ...(!['new', 'append', 'update'].includes(result?.action) ? ['action'] : []),
      ...(!Array.isArray(result?.items) ? ['items'] : []),
      ...(!Object.hasOwn(result || {}, 'clarificationQuestion') || result.clarificationQuestion != null && typeof result.clarificationQuestion !== 'string' ? ['clarificationQuestion'] : []),
      ...items.flatMap((item, index) => foodItemIssues(item).map((issue) => `items[${index}].${issue}`)),
      ...(answeredPendingQuantity && (!items.length || items.some((item) => item.quantityGrams == null && !hasExplicitVolume(item))) ? ['quantityGrams'] : []),
    ];
    let replyIssues = getReplyIssues();
    const macroIssues = () => replyIssues.some((issue) => /\.macros(?:$|\.)|macro_unit_bounds|energy_unit_bounds|energy_4_4_9_mismatch/.test(issue));
    const retryLimit = macroIssues() ? 3 : 1;
    for (let attempt = 1; attempt <= retryLimit && (replyIssues.length || (!items.length && !result?.clarificationQuestion)); attempt++) {
      traceFoodSession(trace, 'reply_validation_retry', { issueCount: replyIssues.length || 1, attempt });
      const retryAllowsWebSearch = Boolean(requestArgs.allowWebSearch && !webFetchUsed && (!webSearchUsed || attempt === 1));
      parts = await requestFoodWithSessionRecovery({
        ...requestArgs, description: modelDescription, allowWebSearch: retryAllowsWebSearch,
        retryFeedback: `CORRECCIÓN ${attempt}/${retryLimit}: corrige la respuesta completa en JSON. Problemas: ${replyIssues.length ? replyIssues.join(', ') : 'JSON ausente o ilegible'}. Conserva alimentos, cantidades y aclaraciones confirmados en la sesión y el contexto; no repitas preguntas contestadas. Devuelve todos los campos requeridos. ${macroIssues() ? 'Debes resolver los macros obligatorios de todos los alimentos solicitados: si no hay fuente exacta utilizable, usa valores típicos razonables y marca macroSource:"opencode_estimado" y macroStatus:"estimado"; no dejes macros obligatorios nulos.' : 'No inventes información y pregunta solo si falta un dato necesario.'} Nunca inventes cantidades. Para masa usa quantityGrams; para volumen conserva quantityText y quantityGrams:null, sin convertir volumen a masa por suposición.`,
      });
      if (retryAllowsWebSearch) webSearchUsed ||= usedFoodWebTools(parts);
      if (retryAllowsWebSearch) webFetchUsed ||= usedFoodWebFetch(parts);
      stage = 'parse';
      result = parseReply(parts);
      if (reuseAsNewMeal && result) { result.action = 'new'; result.targetEntryId = null; }
      items = repairEstimatedEnergy(applyOpenFoodFactsMacros(applyFoodMacroReferences(applyExplicitQuantities(Array.isArray(result?.items) ? result.items : [], quantityContext, answeredPendingQuantity), referenceItems), openFoodFactsProducts));
      if (result) result.items = items;
      replyIssues = getReplyIssues();
      if ((replyIssues.length || (!items.length && !result?.clarificationQuestion)) && attempt === retryLimit) {
        stage = 'validation';
        traceFoodSession(trace, 'reply_validation_failed', { stage, errorCode: 'FOOD_RESPONSE_INVALID_STRUCTURE', issueCount: replyIssues.length || 1, issueCodes: replyIssues.slice(0, 20), retries: attempt });
        throw Object.assign(new Error('OpenCode no devolvió un formato válido tras un reintento. No se guardaron los alimentos; vuelve a enviar el mensaje.'), { code: 'FOOD_RESPONSE_INVALID_STRUCTURE' });
      }
    }
    const assistantMessages = Array.isArray(result?.assistantMessages)
      ? result.assistantMessages.filter((message) => typeof message === 'string' && message.trim()
        && !/(?:a cu[aá]l comida|qu[eé] comida|which meal|no hay comidas guardadas|no existe una comida)/i.test(message)).map((message) => message.slice(0, 5000))
      : [];
    let clarification = result?.clarificationQuestion;
    if (reuseAsNewMeal && !items.some((item) => item.referenceSourceMatched)) {
      const sourceTime = foodReference.time.hours.map((hour) => formatFoodTime(hour, foodReference.time.minute)).join(' o ');
      const candidates = referenceItems.map((item) => `${item.name}${item.quantity ? ` (${item.quantity})` : ''}`).join('; ');
      clarification = candidates
        ? `No pude identificar con seguridad qué alimento de la comida de las ${sourceTime} debo reutilizar. Elige uno: ${candidates}.`
        : `No encontré una comida guardada a las ${sourceTime} para reutilizar sus macros. Confirma la hora o indica los macros del alimento.`;
    }
    if (isQuantityQuestion(saved.question) && pendingMasses.length > 1 && items.some((item) => item.quantityGrams == null)) {
      const names = pendingFoodItems.filter((item) => item.quantityGrams == null).map((item) => item.name).join(', ');
      clarification = `Mencionaste varias cantidades (${pendingMasses.join(' g, ')} g). Indica cuál corresponde a cada alimento${names ? `: ${names}` : ''}, por ejemplo “lentejas 150g”.`;
    }
    if (answeredPendingQuantity && isQuantityQuestion(clarification) && items.length && items.every((item) => item.quantityGrams != null)) clarification = null;
    const createsNew = result.action === 'new';
    let effectiveTime = requestedTime && !requestedTime.invalid && (!activeTarget || createsNew) ? requestedTime : null;
    if (asksSelectedDateConfirmation && selectedDateAnswer?.confirmed && selectedDateAnswer.time) effectiveTime = selectedDateAnswer.time;
    let timeClarification = requestedTime?.invalid ? 'No pude interpretar la hora. Indícala como 2:02 p. m. o 14:02.' : null;
    if (!activeTarget && requestedTime?.ambiguous && matchedMeals.length !== 1) {
      const label = `${requestedTime.hours[0] % 12 || 12}${requestedTime.precision === 'minute' ? `:${String(requestedTime.minute).padStart(2, '0')}` : ''}`;
      timeClarification = `¿Te refieres a las ${label} a. m. o p. m.?`;
      effectiveTime = null;
    }
    if (!reuseAsNewMeal && !activeTarget && matchedMeals.length > 1 && !timeClarification
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
    } else if (!reuseAsNewMeal && !clarification && !timeClarification && (requestedTime && !requestedTime.invalid || pendingTarget)) {
      appendTargetId = selectedMeal?.id || null;
    }
    const targetEntryId = updateTargetId || appendTargetId;
    const target = targetEntryId == null ? null : matchedMeals.find((meal) => String(meal.id) === String(targetEntryId));
    const ownedTarget = target && await dbQuery(`SELECT id FROM registros_comidas WHERE id=${target.id} AND usuario_id=${userId} AND fecha_consumo=${textSql(entry.fecha)} AND estado='completado' LIMIT 1;`);
    if (targetEntryId != null && !ownedTarget) { appendTargetId = null; updateTargetId = null; clarification = 'La comida seleccionada ya no está disponible. Indica cuál quieres modificar.'; }
    const asksMacroRepair = /\b(?:recalcul(?:a|ar|en)|complet(?:a|ar|en)|rellen(?:a|ar|en)|faltan|falta)\b.{0,60}\bmacros?\b|\bmacros?\b.{0,60}\b(?:faltantes?|incompletos?|recalcular)\b/i.test(entry.descripcion);
    const asksCorrection = asksMacroRepair || /\b(corrige|corregir|actualiza|actualizar|reemplaza|reemplazar|cambia|cambiar)\b/i.test(entry.descripcion);
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
    if (asksSelectedDateConfirmation && selectedDateAnswer?.confirmed) {
      appendTargetId = null;
      updateTargetId = null;
    }
    traceFoodSession(trace, 'food_destination_resolved', { explicitTime: Boolean(requestedTime && !requestedTime.invalid), resumedTarget: Boolean(activeTarget), candidateCount: matchedMeals.length, appended: Boolean(appendTargetId), updated: Boolean(updateTargetId) });
    let createdAt = null;
    let savedDate = entry.fecha;
    let savedDescription = asksSelectedDateConfirmation && selectedDateAnswer?.confirmed ? saved.description : entry.descripcion;
    if (effectiveTime && appendTargetId == null) {
      const hour = effectiveTime.hours.length === 1 ? effectiveTime.hours[0] : null;
      const calendarDate = entry.fecha;
      createdAt = hour == null ? null : localDateTimeToUtc(calendarDate, hour, effectiveTime.minute, entry.timezone)?.replace(/:00$/, selectedDateAnswer?.lastSecond ? ':59' : ':00');
      if (!createdAt) clarification = [clarification, 'Esa hora no existe en la fecha seleccionada por el cambio de horario. Confirma una hora válida.'].filter(Boolean).join(' ');
    }
    const itemIssues = items.map(foodItemIssues);
    const invalidItems = clarification ? 0 : itemIssues.filter((issues) => issues.length).length;
    if (!clarification && !invalidItems && items.some((item) => item.quantityGrams == null && !hasExplicitVolume(item))) {
      const names = items.filter((item) => item.quantityGrams == null && !hasExplicitVolume(item)).map((item) => item.name).join(', ');
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
      const candidates = items.filter((item) => !foodItemIssues(item).length);
      const persistCandidate = async (item) => {
        try { await dbQuery(`${pendingFoodItemSql(entryId, item, textSql)};`); }
        catch (error) {
          traceFoodSession(trace, 'draft_candidate_persistence_failed', { stage: 'persistence', errorCode: safeOpenCodeErrorCode(error) });
          try { await recordFoodError({ dbQuery, textSql, userId, trace, stage: 'persistence', error }); }
          catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
        }
      };
      if (candidates.length) {
        try { await dbQuery(`START TRANSACTION;${candidates.map((item) => pendingFoodItemSql(entryId, item, textSql)).join(';')};COMMIT;`); }
        catch { for (const item of candidates) await persistCandidate(item); }
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
      const m = Object.fromEntries(Object.entries(item.macros).map(([key, value]) => [key, value == null ? null : value * factor]));
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
    stage = 'verification';
    const [messages, records] = await Promise.all([
      dbQuery(`SELECT JSON_OBJECT('role',role,'content',contenido) FROM registros_comida_interacciones WHERE registro_comida_id=${append || updating ? destinationId : entryId} ORDER BY id;`).then((rows) => rows ? rows.split(/\r?\n/).map((row) => JSON.parse(row)) : []),
      readFoodEntries({ userId, fecha: savedDate, dbQuery, textSql }),
    ]);
    const persisted = records.find((record) => String(record.id) === String(destinationId) && record.state === 'completado');
    const expectedItemCount = append ? (target?.items.length || 0) + items.length
      : updating ? (target?.items.length || 0) + items.filter((item) => item.targetItemId == null).length : items.length;
    const missingUpdatedItems = items.filter((item) => item.targetItemId != null)
      .some((item) => !persisted?.items.some((savedItem) => String(savedItem.itemId) === String(item.targetItemId)));
    if (!persisted || persisted.items.length !== expectedItemCount || missingUpdatedItems) {
      throw Object.assign(new Error('food_entry_readback_mismatch'), { code: 'FOOD_PERSISTENCE_VERIFY_FAILED' });
    }
    traceFoodSession(trace, 'persistence_verified', { entryId: destinationId, itemCount: persisted.items.length });
    try { await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode }); }
    catch (error) {
      traceFoodSession(trace, 'session_cleanup_failed', { stage: 'after_food_saved', errorCode: safeOpenCodeErrorCode(error) });
      try { await recordFoodError({ dbQuery, textSql, userId, trace, stage: 'after_food_saved', error, httpStatus: 200, action: 'DELETE /api/session/{id}' }); }
      catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed', trace_id: trace.id })); }
    }
    await progressRecorder.flush();
    json(response, 200, { state: 'completado', entryId: append || updating ? destinationId : entryId, fecha: savedDate, requestId: entry.requestId, appended: append, updated: updating, records, messages: Array.isArray(messages) ? messages : [], message: confirmation });
  } catch (error) {
    traceFoodSession(trace, 'save_failed', { entryId: entryId || null, stage, errorCode: safeOpenCodeErrorCode(error) });
    try { await recordFoodError({ dbQuery, textSql, userId, trace, stage, error, httpStatus: entryId ? 502 : 503 }); }
    catch { console.error(JSON.stringify({ area: 'error-log', event: 'database_write_failed' })); }
    await progressRecorder.flush();
    if (committed) {
      json(response, 503, { state: 'completado', entryId: committedEntryId, requestId: entry.requestId, message: `${committedConfirmation} No pude verificar la lectura actualizada. Actualiza el día antes de volver a enviar la solicitud.` });
      return;
    }
    if (entryId && /^\d+$/.test(entryId)) {
      const errorCode = safeOpenCodeErrorCode(error);
      const message = error.code === 'FOOD_IDENTITY_REFUSAL' ? 'Se renovó la sesión para continuar el análisis sin pedir tu identidad; vuelve a enviar el alimento.'
        : stage === 'persistence' ? 'El análisis terminó, pero no se pudieron guardar sus alimentos y macros.'
          : stage === 'session_recovery' || stage === 'session_resolution' ? 'No se pudo recuperar la sesión del asistente. Tu borrador y el contexto del chat se conservaron; vuelve a intentarlo.'
            : ['parse', 'validation'].includes(stage) ? 'No pude validar la respuesta después de varios intentos. Tu borrador y el contexto del chat se conservaron; pulsa «Enviar mensaje» para reintentarlo.'
              : errorCode === 'TIMEOUT' ? 'El asistente tardó demasiado en responder. Tu borrador se conservó; vuelve a intentarlo.'
                : errorCode === 'SERVICE_CONFIG' ? 'El servicio de análisis no está configurado correctamente. Tu borrador se conservó; avisa al administrador.'
                  : ['SERVICE_UNAVAILABLE', 'SERVICE_START_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND'].includes(errorCode) ? 'El servicio de análisis no está disponible por ahora. Tu borrador se conservó; vuelve a intentarlo en unos minutos.'
                    : 'El borrador quedó guardado, pero el asistente no completó el análisis. Puedes intentarlo de nuevo.';
      try { await saveFoodInteraction({ dbQuery, textSql, entryId, role: 'assistant', content: `[ERROR_REGISTRO] ${message}` }); } catch {}
      if (!suppressNotification) try { await dbQuery(`${notificationInsertSql({ userId, category: 'comida', state: 'error', title: 'No se pudo completar el registro de comida', message, referenceId: entryId, textSql })};`); } catch {}
      await progressRecorder.flush();
      json(response, 502, { entryId, requestId: entry.requestId, message });
      return;
    }
    await progressRecorder.flush();
    json(response, 503, { error: 'No se pudo iniciar el registro de comida.' });
  } finally {
    await progressRecorder.flush();
  }
}

module.exports = { applyExplicitGrams, applyExplicitQuantities, applyFoodMacroReferences, applyOpenFoodFactsMacros, clearFoodChatHistory, deleteFoodEntry, foodItemIssues, getFoodEntryProgress, hasExplicitVolume, knownFoodsShortcut, localDateTimeToUtc, needsSelectedNutritionDateConfirmation, normalizeFoodReply, parseDeclaredFoodShortcut, parseFoodReferenceTime, parseFoodReply, parseFoodTime, pendingFoodItemSql, readFoodEntries, readPendingFoodDraft, repairEstimatedEnergy, reportFoodProgress, saveFoodEntry, selectedNutritionDateAnswer, usedFoodWebFetch, usedFoodWebTools, validateFoodEntry, validFoodItem };
