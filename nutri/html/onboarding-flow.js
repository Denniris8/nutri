const loginForm = document.querySelector('#loginForm');
const registerForm = document.querySelector('#registerForm');
const errorMessage = document.querySelector('#errorMessage');
const modeButtons = document.querySelectorAll('[data-mode]');
const demoPassword = 'Demo-Prueba-2026!';
const appNoticeDialog = document.querySelector('#appNoticeDialog');
let appNoticeTimer;
const recordDeleteConfirmDialog = document.querySelector('#recordDeleteConfirmDialog');
const notificationsDialog = document.querySelector('#notificationsDialog');
const notificationsList = document.querySelector('#notificationsList');
const notificationsStatus = document.querySelector('#notificationsStatus');
const notificationsBadge = document.querySelector('#notificationsBadge');
const notificationsButton = document.querySelector('#notificationsButton');
const notificationsFilter = document.querySelector('#notificationsFilter');
let notificationItems = [];

const trainingPlanGoalsInput = document.querySelector('#trainingPlanGoals');
const trainingPlanSendButton = document.querySelector('#sendTrainingPlanGoals');
const trainingPlanSaveButton = document.querySelector('#saveTrainingPlan');
const trainingPlanDialog = document.querySelector('#trainingPlanDialog');
const trainingPlanTrigger = document.querySelector('#createTrainingPlanButton');
const trainingPlanTriggerLoading = document.querySelector('#trainingPlanButtonLoading');
const planChatMessages = document.querySelector('#planChatMessages');
const planLoading = document.querySelector('#planLoading');
const planSummaryText = document.querySelector('#planSummaryText');
const savedTrainingPlansList = document.querySelector('#savedTrainingPlans');
let generatedTrainingPlan = null;
let generatedTrainingGoals = null;
let generatedTrainingMacros = null;
let generatedTrainingDayMacros = null;
let savedTrainingPlan = false;
let savedTrainingPlans = [];
let savedTrainingPlansLoadId = 0;
let trainingPlanTargets = null;
let trainingPlanSessionReady = true;

const tmbExplanation = 'Tasa metabólica basal: energía estimada que el cuerpo utiliza en reposo. No equivale al gasto total diario ni a la meta de ingesta.';
const mifflinExplanation = 'Mifflin-St Jeor es una ecuación que estima el metabolismo basal a partir de edad, sexo, estatura y peso compatibles; es una estimación, no una medición.';

function createFoodRequestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function appendPlainText(parent, text) {
  if (!text) return;
  const span = document.createElement('span');
  span.textContent = text;
  parent.append(span);
}

function createTermHelp(term, explanation) {
  const details = document.createElement('details');
  details.className = 'term-help';
  const summary = document.createElement('summary');
  summary.textContent = term;
  summary.setAttribute('aria-label', `Explicación de ${term}`);
  const popup = document.createElement('span');
  popup.className = 'term-help-content';
  popup.setAttribute('role', 'note');
  popup.textContent = explanation;
  details.append(summary, popup);
  return details;
}

document.addEventListener('click', (event) => {
  for (const popup of document.querySelectorAll('.term-help[open]')) {
    if (!popup.contains(event.target)) popup.open = false;
  }
});

function appendTextWithTermHelp(parent, content) {
  const text = String(content || '');
  const terms = /\bTMB\b|Mifflin(?:-St Jeor)?/gi;
  let offset = 0;
  for (const match of text.matchAll(terms)) {
    appendPlainText(parent, text.slice(offset, match.index));
    parent.append(createTermHelp(match[0], /^TMB$/i.test(match[0]) ? tmbExplanation : mifflinExplanation));
    offset = match.index + match[0].length;
  }
  appendPlainText(parent, text.slice(offset));
}

function renderAccountTmbSummary(profile) {
  const summary = document.querySelector('#accountTmbSummary');
  if (!summary) return;
  summary.replaceChildren(createTermHelp('TMB', tmbExplanation));
  if (profile?.restingMetabolismKcal == null) {
    appendPlainText(summary, ' estará disponible cuando haya estatura, sexo y peso biométrico compatibles. ');
    summary.append(createTermHelp('Mifflin', mifflinExplanation));
    appendPlainText(summary, ' requiere edad, sexo, estatura y peso compatibles.');
    return;
  }
  if (profile.restingMetabolismSource === 'mifflin') {
    appendPlainText(summary, ' estimada por ');
    summary.append(createTermHelp('Mifflin', mifflinExplanation));
  } else appendPlainText(summary, profile.restingMetabolismSource === 'bia' ? ' reportada por BIA' : ' registrada');
  appendPlainText(summary, `: ${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 }).format(Number(profile.restingMetabolismKcal))} kcal.`);
}

function setTrainingPlanTargets(macros, trainingMacros = null) {
  trainingPlanTargets = macros ? { rest: macros, training: trainingMacros } : null;
  renderMacroCards(currentFoodEntries);
}

function appendTrainingPlanMessage(role, content) {
  const bubble = document.createElement('div');
  bubble.className = 'food-chat-message';
  bubble.dataset.role = role;
  const speaker = document.createElement('span');
  speaker.className = 'food-chat-speaker';
  speaker.textContent = role === 'user' ? 'Tú' : role === 'error' ? 'Error' : 'Asistente';
  const text = document.createElement('div');
  text.className = 'food-chat-text';
  appendTextWithTermHelp(text, content);
  bubble.append(speaker, text);
  planChatMessages.append(bubble);
  planChatMessages.parentElement.scrollTop = planChatMessages.parentElement.scrollHeight;
}

function renderSavedTrainingPlans() {
  savedTrainingPlansList.replaceChildren();
  if (!savedTrainingPlans.length) {
    const empty = document.createElement('li');
    empty.className = 'hint';
    empty.textContent = 'Aún no hay planes guardados.';
    savedTrainingPlansList.append(empty);
    savedTrainingPlansList.setAttribute('aria-busy', 'false');
    return;
  }
  for (const plan of savedTrainingPlans) {
    const item = document.createElement('li');
    item.className = 'saved-training-plan-card';
    const details = document.createElement('details');
    details.className = 'saved-training-plan';
    const summary = document.createElement('summary');
    const date = document.createElement('strong');
    const dateLabel = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(plan.createdAt));
    date.textContent = `Plan · ${dateLabel}`;
    const goals = document.createElement('span');
    goals.textContent = `Objetivo: ${plan.goals}`;
    const macros = document.createElement('span');
    const formatMacro = (value, unit) => value == null ? '—' : `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(value)} ${unit}`;
    macros.className = 'saved-training-plan-macros';
    const macroSummary = (targets) => `Proteína ${formatMacro(targets?.proteinas_g, 'g')} · carbohidratos ${formatMacro(targets?.carbohidratos_g, 'g')} · grasas ${formatMacro(targets?.grasas_g, 'g')} · energía ${formatMacro(targets?.calorias_kcal, 'kcal')}`;
    macros.textContent = `Reposo: ${macroSummary(plan.macros)} · Entrenamiento: ${macroSummary(plan.trainingMacros)}`;
    summary.append(date, goals, macros);
    const content = document.createElement('div');
    content.className = 'saved-training-plan-content';
    appendTextWithTermHelp(content, plan.plan);
    details.append(summary, content);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'meal-delete-button saved-training-plan-delete';
    remove.textContent = '−';
    remove.title = 'Eliminar plan';
    remove.setAttribute('aria-label', `Eliminar plan guardado del ${dateLabel}`);
    remove.addEventListener('click', async () => {
      if (!await confirmRecordDelete(`¿Eliminar este plan guardado del ${dateLabel}? Esta acción no se puede deshacer.`)) return;
      remove.disabled = true;
      try {
        const response = await fetch(`/api/training-plans/${encodeURIComponent(plan.id)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!response.ok) throw new Error((await response.json()).error || 'No se pudo eliminar el plan.');
        notifyApp('Plan de entrenamiento eliminado.', 'success');
        await loadSavedTrainingPlans();
      } catch (error) {
        notifyApp(error.message || 'No se pudo eliminar el plan.', 'error');
        remove.disabled = false;
      }
    });
    item.append(details, remove);
    savedTrainingPlansList.append(item);
  }
  savedTrainingPlansList.setAttribute('aria-busy', 'false');
}

async function loadSavedTrainingPlans() {
  if (!savedTrainingPlansList) return;
  const loadId = ++savedTrainingPlansLoadId;
  try {
    const response = await fetch('/api/training-plans', { credentials: 'same-origin' });
    const result = await response.json();
    if (loadId !== savedTrainingPlansLoadId) return;
    if (!response.ok) throw new Error(result.error || 'No se pudieron cargar los planes guardados.');
    savedTrainingPlans = Array.isArray(result.plans) ? result.plans : [];
    renderSavedTrainingPlans();
    if (!generatedTrainingMacros || savedTrainingPlan) setTrainingPlanTargets(savedTrainingPlans[0]?.macros, savedTrainingPlans[0]?.trainingMacros);
  } catch (error) {
    if (loadId !== savedTrainingPlansLoadId) return;
    const message = document.createElement('li');
    message.className = 'hint';
    message.textContent = error.message || 'No se pudieron cargar los planes guardados.';
    savedTrainingPlansList.replaceChildren(message);
    savedTrainingPlansList.setAttribute('aria-busy', 'false');
    if (!generatedTrainingMacros || savedTrainingPlan) setTrainingPlanTargets(null);
    notifyApp(message.textContent, 'error');
  }
}

if (savedTrainingPlansList) void loadSavedTrainingPlans();

trainingPlanTrigger?.addEventListener('click', () => {
  if (!trainingPlanSessionReady) planSummaryText.textContent = 'Cuéntame tus objetivos y generaré un plan con tus datos registrados.';
  trainingPlanSessionReady = true;
  trainingPlanGoalsInput.disabled = false;
  trainingPlanSendButton.disabled = false;
  planSummaryText.classList.remove('food-session-error');
  trainingPlanDialog?.showModal();
  trainingPlanGoalsInput?.focus();
});
document.querySelector('#closeTrainingPlanDialog')?.addEventListener('click', () => trainingPlanDialog?.close());
document.querySelector('#cancelTrainingPlanDialog')?.addEventListener('click', () => trainingPlanDialog?.close());
trainingPlanDialog?.addEventListener('close', () => trainingPlanTrigger?.focus());

trainingPlanSendButton?.addEventListener('click', async () => {
  if (!trainingPlanSessionReady) return;
  const goals = trainingPlanGoalsInput.value.trim();
  if (!goals) {
    trainingPlanGoalsInput.focus();
    notifyApp('Describe tus objetivos para generar el plan.', 'error');
    return;
  }
  trainingPlanSendButton.disabled = true;
  trainingPlanGoalsInput.disabled = true;
  trainingPlanSaveButton.hidden = true;
  trainingPlanSaveButton.disabled = true;
  trainingPlanSaveButton.textContent = 'Guardar';
  trainingPlanSaveButton.title = 'Guardar el plan generado';
  generatedTrainingPlan = null;
  generatedTrainingGoals = null;
  generatedTrainingMacros = null;
  generatedTrainingDayMacros = null;
  savedTrainingPlan = false;
  setTrainingPlanTargets(savedTrainingPlans[0]?.macros, savedTrainingPlans[0]?.trainingMacros);
  planSummaryText.textContent = 'Generando plan…';
  planLoading.hidden = false;
  trainingPlanTrigger.setAttribute('aria-busy', 'true');
  trainingPlanTriggerLoading.hidden = false;
  appendTrainingPlanMessage('user', goals);
  notifyApp('Generando tu plan de entrenamiento.', 'info');
  try {
    const response = await fetch('/api/training-plan', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goals, suppressNotification: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo generar el plan.');
    appendTrainingPlanMessage('assistant', result.plan);
    generatedTrainingPlan = result.plan;
    generatedTrainingGoals = goals;
    generatedTrainingMacros = result.macros;
    generatedTrainingDayMacros = result.trainingMacros;
    setTrainingPlanTargets(generatedTrainingMacros, generatedTrainingDayMacros);
    trainingPlanGoalsInput.value = '';
    trainingPlanSaveButton.hidden = false;
    trainingPlanSaveButton.disabled = false;
    trainingPlanSaveButton.title = '';
    planSummaryText.textContent = 'Plan generado · no guardado';
    notifyApp('Plan generado. Solo aparece en esta vista y no se guarda.', 'success');
    await notifyResultIfHidden(trainingPlanDialog, 'plan', 'generado', 'Plan generado, aún sin guardar', 'Tu plan está listo para revisar y guardar.');
  } catch (error) {
    const sessionFailed = error.message === 'No se pudo abrir la sesión para crear el plan.';
    if (sessionFailed) {
      trainingPlanSessionReady = false;
      planSummaryText.textContent = error.message;
      planSummaryText.classList.add('food-session-error');
    } else planSummaryText.textContent = 'No se pudo generar el plan.';
    appendTrainingPlanMessage('error', error.message || 'No se pudo generar el plan.');
    notifyApp(error.message || 'No se pudo generar el plan.', 'error');
    await notifyResultIfHidden(trainingPlanDialog, 'plan', 'error', 'No se pudo generar el plan', 'Revisa el modal de plan e inténtalo de nuevo.');
  } finally {
    planLoading.hidden = true;
    trainingPlanTrigger.setAttribute('aria-busy', 'false');
    trainingPlanTriggerLoading.hidden = true;
    trainingPlanSendButton.disabled = !trainingPlanSessionReady;
    trainingPlanGoalsInput.disabled = !trainingPlanSessionReady;
    if (trainingPlanSessionReady) trainingPlanGoalsInput.focus();
  }
});

trainingPlanSaveButton?.addEventListener('click', async () => {
  if (!generatedTrainingPlan || !generatedTrainingGoals || !generatedTrainingMacros || !generatedTrainingDayMacros || savedTrainingPlan) return;
  trainingPlanSaveButton.disabled = true;
  notifyApp('Guardando el plan de entrenamiento.', 'info');
  try {
    const response = await fetch('/api/training-plans', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goals: generatedTrainingGoals, plan: generatedTrainingPlan, macros: generatedTrainingMacros, trainingMacros: generatedTrainingDayMacros, suppressNotification: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo guardar el plan.');
    const savedAt = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(result.createdAt));
    savedTrainingPlan = true;
    setTrainingPlanTargets(generatedTrainingMacros, generatedTrainingDayMacros);
    savedTrainingPlans = [{ id: result.id, createdAt: result.createdAt, goals: generatedTrainingGoals, plan: generatedTrainingPlan, macros: generatedTrainingMacros, trainingMacros: generatedTrainingDayMacros }, ...savedTrainingPlans.filter((plan) => plan.id !== result.id)].slice(0, 3);
    renderSavedTrainingPlans();
    void loadSavedTrainingPlans();
    trainingPlanSaveButton.textContent = 'Guardado';
    trainingPlanSaveButton.title = `Plan guardado el ${savedAt}`;
    planSummaryText.textContent = `Plan guardado · ${savedAt}`;
    appendTrainingPlanMessage('assistant', `Plan guardado el ${savedAt}.`);
    notifyApp('Plan de entrenamiento guardado.', 'success');
    await notifyResultIfHidden(trainingPlanDialog, 'plan', 'guardado', 'Plan guardado', 'Tu plan de entrenamiento quedó guardado.', result.id);
  } catch (error) {
    trainingPlanSaveButton.disabled = false;
    appendTrainingPlanMessage('error', error.message || 'No se pudo guardar el plan.');
    notifyApp(error.message || 'No se pudo guardar el plan.', 'error');
    await notifyResultIfHidden(trainingPlanDialog, 'plan', 'error', 'No se pudo guardar el plan', 'Intenta guardar el plan nuevamente.');
  }
});

function confirmRecordDelete(message) {
  if (!recordDeleteConfirmDialog) return Promise.resolve(false);
  document.querySelector('#recordDeleteConfirmMessage').textContent = message;
  recordDeleteConfirmDialog.returnValue = '';
  return new Promise((resolve) => {
    recordDeleteConfirmDialog.addEventListener('close', () => resolve(recordDeleteConfirmDialog.returnValue === 'confirm'), { once: true });
    recordDeleteConfirmDialog.showModal();
  });
}

document.querySelector('#closeRecordDeleteConfirm')?.addEventListener('click', () => recordDeleteConfirmDialog.close('cancel'));
document.querySelector('#cancelRecordDeleteConfirm')?.addEventListener('click', () => recordDeleteConfirmDialog.close('cancel'));
document.querySelector('#acceptRecordDeleteConfirm')?.addEventListener('click', () => recordDeleteConfirmDialog.close('confirm'));

function notifyApp(message, kind = 'info') {
  if (!message || !appNoticeDialog) return;
  const text = document.querySelector('#appNoticeText');
  text.textContent = message;
  text.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  appNoticeDialog.dataset.kind = kind;
  if (!appNoticeDialog.matches(':popover-open')) appNoticeDialog.showPopover();
  clearTimeout(appNoticeTimer);
  appNoticeTimer = setTimeout(() => appNoticeDialog.hidePopover(), 5000);
}

const notificationStateLabels = { requiere_respuesta: 'Requiere respuesta', guardado: 'Guardado', generado: 'Generado', error: 'Error', resuelta: 'Resuelta' };
async function notifyResultIfHidden(dialog, category, state, title, message, referenceId = null) {
  if (dialog?.open && !document.hidden) return;
  try {
    await fetch('/api/notifications', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, state, title, message: String(message).slice(0, 2000), referenceId }),
    });
    void refreshNotifications();
  } catch {}
}
async function refreshNotifications() {
  if (!notificationsList) return;
  notificationsList.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/notifications', { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const result = await response.json();
    notificationItems = result.notifications || [];
    renderNotifications();
    const unread = Number(result.unreadCount) || 0;
    notificationsBadge.hidden = unread < 1;
    notificationsBadge.textContent = unread > 99 ? '99+' : String(unread);
    notificationsButton.setAttribute('aria-label', `Alertas${unread ? `, ${unread} sin leer` : ''}`);
  } catch {
    if (notificationsStatus) notificationsStatus.textContent = 'No se pudieron cargar las alertas. Intenta nuevamente.';
  } finally {
    notificationsList.setAttribute('aria-busy', 'false');
  }
}

function renderNotifications() {
  notificationsList.replaceChildren();
  const filter = notificationsFilter?.value || 'todas';
  const visibleItems = notificationItems.filter((notification) => filter === 'todas'
    || filter === 'sin-leer' && !notification.readAt
    || filter === 'requiere_respuesta' && notification.state === filter
    || ['comida', 'entrenamiento', 'plan'].includes(filter) && notification.category === filter);
  for (const notification of visibleItems) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.id = notification.id;
      button.dataset.category = notification.category;
      button.dataset.state = notification.state;
      button.dataset.message = notification.message;
      button.dataset.unread = String(!notification.readAt);
      const heading = document.createElement('span');
      heading.className = 'notification-heading';
      const title = document.createElement('strong');
      title.textContent = notification.title;
      const state = document.createElement('span');
      state.className = 'notification-state';
      state.textContent = notificationStateLabels[notification.state] || 'Aviso';
      heading.append(title, state);
      const message = document.createElement('p');
      message.className = 'notification-message';
      message.textContent = notification.message;
      const date = document.createElement('span');
      date.className = 'notification-date';
      date.textContent = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(notification.createdAt));
      const action = document.createElement('span');
      action.className = 'notification-action';
      action.textContent = notification.state === 'requiere_respuesta' ? 'Abrir y responder →' : 'Marcar como leída';
      button.append(heading, message, date, action);
      item.append(button);
      notificationsList.append(item);
  }
  notificationsStatus.textContent = visibleItems.length ? '' : notificationItems.length ? 'No hay alertas que coincidan con este filtro.' : 'No tienes alertas recientes.';
}

notificationsButton?.addEventListener('click', () => { void refreshNotifications(); notificationsDialog.showModal(); });
document.querySelector('#closeNotificationsDialog')?.addEventListener('click', () => notificationsDialog.close());
notificationsDialog?.addEventListener('close', () => notificationsButton?.focus());
notificationsFilter?.addEventListener('change', renderNotifications);
document.querySelector('#markNotificationsRead')?.addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const filter = notificationsFilter?.value || 'todas';
  const ids = notificationItems.filter((item) => !item.readAt && (filter === 'todas'
    || filter === 'sin-leer'
    || filter === 'requiere_respuesta' && item.state === filter
    || ['comida', 'entrenamiento', 'plan'].includes(filter) && item.category === filter)).map((item) => item.id);
  if (!ids.length) { button.textContent = 'No hay alertas sin leer'; return; }
  button.disabled = true;
  try {
    await Promise.all(ids.map((id) => fetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'POST', credentials: 'same-origin' })));
    await refreshNotifications();
    button.textContent = 'Alertas marcadas como leídas';
  } catch { notificationsStatus.textContent = 'No se pudieron actualizar las alertas.'; }
  finally { button.disabled = false; setTimeout(() => { button.textContent = 'Marcar visibles como leídas'; }, 2500); }
});
notificationsList?.addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  if (button.dataset.category === 'plan' && button.dataset.unread !== 'true') return;
  try {
    await fetch(`/api/notifications/${encodeURIComponent(button.dataset.id)}/read`, { method: 'POST', credentials: 'same-origin' });
    await refreshNotifications();
  } catch {}
  if (button.dataset.category === 'plan') {
    notificationsDialog.close();
    trainingPlanTrigger?.click();
    return;
  }
  if (button.dataset.state !== 'requiere_respuesta') return;
  notificationsDialog.close();
  if (button.dataset.category === 'comida') document.querySelector('#registerFoodButton')?.click();
  if (button.dataset.category === 'entrenamiento') {
    document.querySelector('#addTrainingButton')?.click();
    if (!trainingChatMessages.textContent.includes(button.dataset.message)) appendTrainingMessage('assistant', button.dataset.message);
  }
});
if (notificationsList) {
  void refreshNotifications();
  setInterval(() => { if (!document.hidden) void refreshNotifications(); }, 60000);
}

function navigateWithNotice(message, url) {
  try { sessionStorage.setItem('nutriAppNotice', message); } catch {}
  window.location.assign(url);
}

document.querySelector('#appNoticeClose')?.addEventListener('click', () => appNoticeDialog.hidePopover());
try {
  const pendingNotice = sessionStorage.getItem('nutriAppNotice');
  if (pendingNotice) { sessionStorage.removeItem('nutriAppNotice'); notifyApp(pendingNotice, 'success'); }
} catch {}

if (loginForm) {
  document.querySelector('#loginCelular').value = '+52 0000000000';
  document.querySelector('#loginPassword').value = demoPassword;
}

function setMode(mode) {
  const registering = mode === 'register';
  loginForm.hidden = registering;
  registerForm.hidden = !registering;
  if (registering && registerForm.dataset.demoPrefilled !== 'true') {
    document.querySelector('#registerName').value = 'Usuario de prueba';
    document.querySelector('#registerCountryCode').value = 'MX';
    document.querySelector('#registerCelular').value = '0000000000';
    document.querySelector('#registerPassword').value = demoPassword;
    document.querySelector('#confirmPassword').value = demoPassword;
    document.querySelector('#registerAge').value = '30';
    document.querySelector('#registerSex').value = 'masculino';
    document.querySelector('#registerTestAccount').value = 'true';
    registerForm.dataset.demoPrefilled = 'true';
  }
  modeButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
  });
  errorMessage.textContent = '';
}

modeButtons.forEach((button) => {
  button.addEventListener('click', () => setMode(button.dataset.mode));
});

document.querySelector('#cancelRegister')?.addEventListener('click', () => setMode('login'));

loginForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.textContent = '';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: document.querySelector('#loginCelular').value, password: document.querySelector('#loginPassword').value }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudo iniciar sesión.');
    }
    navigateWithNotice('Sesión iniciada.', '/dashboard_nutricional.html');
  } catch (error) {
    errorMessage.textContent = error.message || 'No se pudo iniciar sesión. Intenta de nuevo.';
    notifyApp(errorMessage.textContent, 'error');
  }
});

registerForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = document.querySelector('#registerPassword');
  const confirmation = document.querySelector('#confirmPassword');
  if (password.value !== confirmation.value) {
    confirmation.setCustomValidity('Las contraseñas no coinciden.');
    confirmation.reportValidity();
    return;
  }
  errorMessage.textContent = '';
  try {
    const response = await fetch('/api/auth/register', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: document.querySelector('#registerName').value,
        countryIso: document.querySelector('#registerCountryCode').value,
        phone: document.querySelector('#registerCelular').value,
        password: password.value,
        age: document.querySelector('#registerAge').value,
        heightCm: document.querySelector('#registerHeight').value,
        sex: document.querySelector('#registerSex').value,
        isTestAccount: document.querySelector('#registerTestAccount').value === 'true',
      }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudo crear la cuenta.');
    }
    navigateWithNotice('Cuenta creada.', '/preferencias.html');
  } catch (error) {
    errorMessage.textContent = error.message === 'Ya existe una cuenta con ese celular.'
      ? `${error.message} Inicia sesión.`
      : error.message || 'No se pudo crear la cuenta. Intenta de nuevo.';
    notifyApp(errorMessage.textContent, 'error');
  }
});

document.querySelector('#confirmPassword')?.addEventListener('input', (event) => {
  event.currentTarget.setCustomValidity('');
});

registerForm?.addEventListener('input', (event) => {
  if (event.target.id !== 'registerTestAccount') document.querySelector('#registerTestAccount').value = 'false';
});
registerForm?.addEventListener('change', (event) => {
  if (event.target.id !== 'registerTestAccount') document.querySelector('#registerTestAccount').value = 'false';
});

const preferencesForm = document.querySelector('#preferencesForm');
const preferencesEditMode = /(?:\?|&)edit=1(?:&|$)/.test(window.location.search || '');
const garminDeviceOption = document.querySelector('#deviceModeGarmin');
const manualDeviceOption = document.querySelector('#deviceModeManual');
const garminCredentialsSection = document.querySelector('#integrationCredentialsSection');
const garminVerifyButton = document.querySelector('#verifyGarminButton');
let garminProof = '';
let garminSaved = false;
let garminExisting = false;
let garminChanged = false;
function updateGarminButton() {
  garminVerifyButton.disabled = garminSaved;
  garminVerifyButton.classList.toggle('is-verified', garminSaved);
  garminVerifyButton.textContent = garminSaved ? 'Cuenta correcta' : 'Probar cuenta';
}
function showGarminCredentials() {
  const visible = !!garminDeviceOption?.checked;
  if (garminCredentialsSection) garminCredentialsSection.hidden = !visible;
  if (garminVerifyButton) garminVerifyButton.hidden = !visible;
  if (!visible) {
    const username = document.querySelector('#integrationUsername');
    const password = document.querySelector('#integrationPassword');
    if (username && !garminExisting) username.value = '';
    if (password) password.value = '';
  }
}
garminDeviceOption?.addEventListener('change', showGarminCredentials);
manualDeviceOption?.addEventListener('change', () => {
  if (!garminExisting) { garminProof = ''; garminSaved = false; updateGarminButton(); }
  showGarminCredentials();
});
for (const field of ['#integrationUsername', '#integrationPassword']) {
  document.querySelector(field)?.addEventListener('input', () => {
    garminProof = '';
    garminSaved = false;
    garminExisting = false;
    garminChanged = true;
    updateGarminButton();
    document.querySelector('#integrationCredentialsNote').textContent = 'Vuelve a probar la cuenta después de cambiar las credenciales.';
  });
}
showGarminCredentials();
garminVerifyButton?.addEventListener('click', async () => {
  const email = document.querySelector('#integrationUsername').value.trim();
  const password = document.querySelector('#integrationPassword').value;
  const note = document.querySelector('#integrationCredentialsNote');
  if (!email || !password) {
    note.textContent = 'Introduce correo y contraseña para probar la cuenta.';
    notifyApp(note.textContent, 'warning');
    return;
  }
  garminVerifyButton.disabled = true;
  garminVerifyButton.textContent = 'Probando cuenta…';
  document.querySelector('#integrationUsername').disabled = true;
  document.querySelector('#integrationPassword').disabled = true;
  garminDeviceOption.disabled = true;
  manualDeviceOption.disabled = true;
  garminProof = '';
  garminSaved = false;
  note.textContent = 'Validando credenciales con Garmin Connect…';
  try {
    const response = await fetch('/api/garmin/verify', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo validar la cuenta Garmin.');
    garminProof = result.proof;
    garminSaved = true;
    garminExisting = false;
    garminChanged = false;
    note.textContent = 'Cuenta Garmin correcta. Al guardar las preferencias, las credenciales se almacenarán cifradas.';
    updateGarminButton();
    notifyApp(note.textContent, 'success');
  } catch (error) {
    note.textContent = error.message || 'No se pudo validar la cuenta Garmin.';
    notifyApp(note.textContent, 'error');
  } finally {
    document.querySelector('#integrationUsername').disabled = false;
    document.querySelector('#integrationPassword').disabled = false;
    garminDeviceOption.disabled = false;
    manualDeviceOption.disabled = false;
    if (!garminSaved) updateGarminButton();
  }
});
if (preferencesEditMode) {
  document.querySelector('#preferencesStep').textContent = 'Más · Edición de preferencias';
  document.querySelector('#preferencesTitle').textContent = 'Actualizar preferencias personales';
  document.querySelector('#preferencesIntro').textContent = 'Corrige tus preferencias guardadas. Los cambios reemplazarán la información actual de tu perfil.';
  document.querySelector('#savePreferencesButton').textContent = 'Guardar cambios';
  document.querySelector('#cancelPreferences').textContent = 'Cancelar';
}
function toggleDetails(statusId, labelId, detailsId, visibleValue) {
  const visible = document.querySelector(`#${statusId}`).value === visibleValue;
  document.querySelector(`#${labelId}`).hidden = !visible;
  document.querySelector(`#${detailsId}`).hidden = !visible;
  document.querySelector(`#${detailsId}`).required = visible;
}

for (const [status, label, details, value] of [
  ['allergiesStatus', 'allergiesDetailsLabel', 'allergiesDetails', 'registradas'],
  ['medicationsStatus', 'medicationsDetailsLabel', 'medicationsDetails', 'registrados'],
]) {
  const select = document.querySelector(`#${status}`);
  select?.addEventListener('change', () => toggleDetails(status, label, details, value));
  if (select) toggleDetails(status, label, details, value);
}

function setClock(prefix, time) {
  if (!time) return;
  const [hour24, minute] = time.slice(0, 5).split(':').map(Number);
  document.querySelector(`#${prefix}Hour`).value = String(hour24 % 12 || 12);
  document.querySelector(`#${prefix}Minute`).value = String(minute);
  document.querySelector(`#${prefix}Period`).value = hour24 < 12 ? 'AM' : 'PM';
}

if (preferencesForm && preferencesEditMode) {
  const saveButton = document.querySelector('#savePreferencesButton');
  let loaded = false;
  saveButton.disabled = true;
  fetch('/api/onboarding/preferences?includeGarminEmail=1', { credentials: 'same-origin' }).then(async (response) => {
    if (!response.ok) throw new Error();
    return (await response.json()).preferences;
  }).then((saved) => {
    const set = (id, value) => { document.querySelector(`#${id}`).value = value ?? ''; };
    set('dietPattern', saved.patronAlimentario);
    set('preferredFoods', saved.preferredFoods);
    set('avoidedFoods', saved.avoidedFoods);
    set('allergiesStatus', saved.allergiesStatus);
    set('allergiesDetails', saved.allergiesDetails);
    set('medicationsStatus', saved.medicationsStatus);
    set('medicationsDetails', saved.medicationsDetails);
    set('integrationUsername', saved.garminEmail);
    document.querySelector('#deviceModeManual').checked = saved.deviceMode === 'ninguno';
    document.querySelector('#deviceModeGarmin').checked = saved.deviceMode === 'garmin';
    garminExisting = saved.garminConnected === true;
    garminSaved = garminExisting;
    garminChanged = false;
    if (garminSaved) document.querySelector('#integrationCredentialsNote').textContent = 'Cuenta Garmin ya guardada y verificada.';
    updateGarminButton();
    showGarminCredentials();
    setClock('nutritionDayStart', saved.nutritionDayStart);
    setClock('nutritionDayEnd', saved.nutritionDayEnd);
    toggleDetails('allergiesStatus', 'allergiesDetailsLabel', 'allergiesDetails', 'registradas');
    toggleDetails('medicationsStatus', 'medicationsDetailsLabel', 'medicationsDetails', 'registrados');
    document.querySelector('#testDataNotice').hidden = true;
    loaded = true;
  }).catch(() => {
    document.querySelector('#formError').textContent = 'No se pudieron cargar tus preferencias.';
    notifyApp(document.querySelector('#formError').textContent, 'error');
  }).finally(() => { saveButton.disabled = !loaded; });
} else if (preferencesForm && !document.querySelector('#dietPattern').value) {
  document.querySelector('#nutritionDayStartHour').value = '9';
  document.querySelector('#nutritionDayStartMinute').value = '0';
  document.querySelector('#nutritionDayStartPeriod').value = 'AM';
  document.querySelector('#nutritionDayEndHour').value = '2';
  document.querySelector('#nutritionDayEndMinute').value = '0';
  document.querySelector('#nutritionDayEndPeriod').value = 'AM';
  document.querySelector('#deviceModeManual').checked = true;
  showGarminCredentials();
  document.querySelector('#dietPattern').value = 'sin_preferencia';
  document.querySelector('#preferredFoods').value = 'Comidas variadas y sencillas';
  document.querySelector('#avoidedFoods').value = 'Alimentos muy picantes';
  document.querySelector('#allergiesStatus').value = 'sin_informacion';
  document.querySelector('#medicationsStatus').value = 'sin_informacion';
  document.querySelector('#testDataNotice').hidden = false;
}

preferencesForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone) {
    document.querySelector('#formError').textContent = 'No se pudo detectar la zona horaria del navegador.';
    notifyApp(document.querySelector('#formError').textContent, 'error');
    return;
  }
  try {
    const response = await fetch('/api/onboarding/preferences', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Client-Timezone': timezone },
      body: JSON.stringify({
        deviceMode: document.querySelector('#deviceModeManual').checked ? 'ninguno'
          : document.querySelector('#deviceModeGarmin').checked ? 'garmin' : '',
        patronAlimentario: document.querySelector('#dietPattern').value,
        preferredFoods: document.querySelector('#preferredFoods').value,
        avoidedFoods: document.querySelector('#avoidedFoods').value,
        allergiesStatus: document.querySelector('#allergiesStatus').value,
        allergiesDetails: document.querySelector('#allergiesDetails').value,
        medicationsStatus: document.querySelector('#medicationsStatus').value,
        medicationsDetails: document.querySelector('#medicationsDetails').value,
        nutritionWindow: {
          start: Object.fromEntries(['Hour', 'Minute', 'Period'].map((part) => [part.toLowerCase(), document.querySelector(`#nutritionDayStart${part}`).value])),
          end: Object.fromEntries(['Hour', 'Minute', 'Period'].map((part) => [part.toLowerCase(), document.querySelector(`#nutritionDayEnd${part}`).value])),
        },
        ...(garminDeviceOption.checked && garminProof ? {
          garminEmail: document.querySelector('#integrationUsername').value.trim(),
          garminPassword: document.querySelector('#integrationPassword').value,
          garminProof,
        } : garminDeviceOption.checked ? { garminCredentialsModified: garminChanged } : {}),
      }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudieron guardar las preferencias.');
    }
    navigateWithNotice('Preferencias guardadas.', preferencesEditMode ? '/dashboard_nutricional.html?view=more' : '/terminos.html');
  } catch (error) {
    document.querySelector('#formError').textContent = error.message || 'No se pudieron guardar las preferencias.';
    notifyApp(document.querySelector('#formError').textContent, 'error');
  }
});

async function logout(statusElement) {
  if (statusElement) statusElement.textContent = '';
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    navigateWithNotice('Sesión cerrada.', '/login.html');
  } catch {
    if (statusElement) statusElement.textContent = 'No se pudo cerrar la sesión. Intenta de nuevo.';
    notifyApp(statusElement?.textContent || 'No se pudo cerrar la sesión.', 'error');
  }
}

document.querySelector('#cancelPreferences')?.addEventListener('click', () => preferencesEditMode
  ? window.location.assign('/dashboard_nutricional.html?view=more')
  : logout(document.querySelector('#formError')));

const preferencesEditDialog = document.querySelector('#preferencesEditDialog');
const preferencesEditForm = document.querySelector('#preferencesEditForm');
let editGarminProof = '';
let editGarminSaved = false;
let editGarminStored = false;
let editGarminChanged = false;
function updateEditGarminState() {
  const button = document.querySelector('#editVerifyGarminButton');
  const stored = document.querySelector('#editUnlinkGarminButton');
  button.disabled = editGarminSaved;
  button.hidden = !document.querySelector('#editDeviceModeGarmin').checked;
  button.classList.toggle('garmin-verified-button', editGarminSaved);
  button.textContent = editGarminSaved ? 'Cuenta correcta' : 'Probar cuenta';
  stored.hidden = !editGarminStored;
}
function showEditGarminCredentials() {
  document.querySelector('#editGarminCredentialsSection').hidden = !document.querySelector('#editDeviceModeGarmin').checked && !editGarminStored;
  updateEditGarminState();
}
document.querySelector('#editDeviceModeManual')?.addEventListener('change', showEditGarminCredentials);
document.querySelector('#editDeviceModeGarmin')?.addEventListener('change', showEditGarminCredentials);
for (const id of ['editGarminUsername', 'editGarminPassword']) {
  document.querySelector(`#${id}`)?.addEventListener('input', () => {
    editGarminProof = '';
    editGarminSaved = false;
    editGarminChanged = true;
    document.querySelector('#editGarminCredentialsNote').textContent = 'Vuelve a probar la cuenta después de cambiar las credenciales.';
    updateEditGarminState();
  });
}
document.querySelector('#editVerifyGarminButton')?.addEventListener('click', async () => {
  const email = document.querySelector('#editGarminUsername').value.trim();
  const password = document.querySelector('#editGarminPassword').value;
  const note = document.querySelector('#editGarminCredentialsNote');
  const button = document.querySelector('#editVerifyGarminButton');
  if (!email || !password) { note.textContent = 'Introduce correo y contraseña para probar la cuenta.'; return; }
  button.disabled = true;
  button.textContent = 'Probando cuenta…';
  document.querySelector('#editGarminUsername').disabled = true;
  document.querySelector('#editGarminPassword').disabled = true;
  document.querySelector('#editDeviceModeManual').disabled = true;
  document.querySelector('#editDeviceModeGarmin').disabled = true;
  editGarminProof = '';
  editGarminSaved = false;
  note.textContent = 'Validando credenciales con Garmin Connect…';
  try {
    const response = await fetch('/api/garmin/verify', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo validar la cuenta Garmin.');
    editGarminProof = result.proof;
    editGarminSaved = true;
    editGarminChanged = false;
    note.textContent = 'Cuenta correcta. Se guardará cifrada al guardar las preferencias.';
    notifyApp(note.textContent, 'success');
  } catch (error) {
    note.textContent = error.message || 'No se pudo validar la cuenta Garmin.';
    notifyApp(note.textContent, 'error');
  } finally {
    document.querySelector('#editGarminUsername').disabled = false;
    document.querySelector('#editGarminPassword').disabled = false;
    document.querySelector('#editDeviceModeManual').disabled = false;
    document.querySelector('#editDeviceModeGarmin').disabled = false;
    updateEditGarminState();
  }
});
document.querySelector('#editUnlinkGarminButton')?.addEventListener('click', async () => {
  const button = document.querySelector('#editUnlinkGarminButton');
  const feedback = document.querySelector('#preferencesEditFeedback');
  button.disabled = true;
  try {
    const response = await fetch('/api/integrations/garmin', { method: 'DELETE', credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json()).error || 'No se pudo desvincular Garmin.');
    editGarminProof = '';
    editGarminSaved = false;
    editGarminStored = false;
    editGarminChanged = false;
    document.querySelector('#editDeviceModeManual').checked = true;
    document.querySelector('#editGarminUsername').value = '';
    document.querySelector('#editGarminPassword').value = '';
    document.querySelector('#editGarminCredentialsNote').textContent = 'Cuenta desvinculada. Puedes continuar en modo manual.';
    showEditGarminCredentials();
    updateEditGarminState();
    feedback.textContent = 'Cuenta Garmin desvinculada.';
    notifyApp(feedback.textContent, 'success');
  } catch (error) {
    feedback.textContent = error.message || 'No se pudo desvincular Garmin.';
    notifyApp(feedback.textContent, 'error');
  } finally { button.disabled = false; }
});
document.querySelector('#morePreferencesButton')?.addEventListener('click', async () => {
  preferencesEditDialog.showModal();
  const save = document.querySelector('#savePreferencesEditButton');
  const feedback = document.querySelector('#preferencesEditFeedback');
  let loaded = false;
  save.disabled = true;
  feedback.textContent = 'Cargando preferencias guardadas…';
  try {
    const response = await fetch('/api/onboarding/preferences?includeGarminEmail=1', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('No se pudieron cargar las preferencias.');
    const { preferences } = await response.json();
    const set = (id, value) => { document.querySelector(`#${id}`).value = value ?? ''; };
    set('editDietPattern', preferences.patronAlimentario);
    set('editPreferredFoods', preferences.preferredFoods);
    set('editAvoidedFoods', preferences.avoidedFoods);
    set('editAllergiesStatus', preferences.allergiesStatus);
    set('editAllergiesDetails', preferences.allergiesDetails);
    set('editMedicationsStatus', preferences.medicationsStatus);
    set('editMedicationsDetails', preferences.medicationsDetails);
    set('editGarminUsername', preferences.garminEmail);
    document.querySelector('#editDeviceModeManual').checked = preferences.deviceMode === 'ninguno';
    document.querySelector('#editDeviceModeGarmin').checked = preferences.deviceMode === 'garmin';
    editGarminStored = preferences.garminConnected === true;
    editGarminSaved = editGarminStored;
    editGarminProof = '';
    editGarminChanged = false;
    document.querySelector('#editGarminCredentialsNote').textContent = editGarminStored
      ? 'Tu cuenta Garmin ya está guardada.' : 'Prueba la cuenta antes de guardar. Las credenciales se almacenan cifradas.';
    showEditGarminCredentials();
    updateEditGarminState();
    setClock('editNutritionStart', preferences.nutritionDayStart);
    setClock('editNutritionEnd', preferences.nutritionDayEnd);
    toggleDetails('editAllergiesStatus', 'editAllergiesDetailsLabel', 'editAllergiesDetails', 'registradas');
    toggleDetails('editMedicationsStatus', 'editMedicationsDetailsLabel', 'editMedicationsDetails', 'registrados');
    feedback.textContent = '';
    loaded = true;
  } catch (error) {
    feedback.textContent = error.message || 'No se pudieron cargar las preferencias.';
    notifyApp(feedback.textContent, 'error');
  } finally {
    save.disabled = !loaded;
  }
});
document.querySelector('#closePreferencesEdit')?.addEventListener('click', () => preferencesEditDialog.close());
document.querySelector('#cancelPreferencesEdit')?.addEventListener('click', () => preferencesEditDialog.close());
preferencesEditForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = document.querySelector('#preferencesEditFeedback');
  const save = document.querySelector('#savePreferencesEditButton');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  feedback.textContent = '';
  save.disabled = true;
  try {
    const response = await fetch('/api/onboarding/preferences', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Client-Timezone': timezone },
      body: JSON.stringify({
        deviceMode: document.querySelector('#editDeviceModeManual').checked ? 'ninguno'
          : document.querySelector('#editDeviceModeGarmin').checked ? 'garmin' : '',
        patronAlimentario: document.querySelector('#editDietPattern').value,
        preferredFoods: document.querySelector('#editPreferredFoods').value,
        avoidedFoods: document.querySelector('#editAvoidedFoods').value,
        allergiesStatus: document.querySelector('#editAllergiesStatus').value,
        allergiesDetails: document.querySelector('#editAllergiesDetails').value,
        medicationsStatus: document.querySelector('#editMedicationsStatus').value,
        medicationsDetails: document.querySelector('#editMedicationsDetails').value,
        nutritionWindow: {
          start: Object.fromEntries(['Hour', 'Minute', 'Period'].map((part) => [part.toLowerCase(), document.querySelector(`#editNutritionStart${part}`).value])),
          end: Object.fromEntries(['Hour', 'Minute', 'Period'].map((part) => [part.toLowerCase(), document.querySelector(`#editNutritionEnd${part}`).value])),
        },
        ...(document.querySelector('#editDeviceModeGarmin').checked && editGarminProof ? {
          garminEmail: document.querySelector('#editGarminUsername').value.trim(),
          garminPassword: document.querySelector('#editGarminPassword').value,
          garminProof: editGarminProof,
        } : document.querySelector('#editDeviceModeGarmin').checked ? { garminCredentialsModified: editGarminChanged } : {}),
      }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudieron guardar las preferencias.');
    }
    preferencesEditDialog.close();
    notifyApp('Preferencias actualizadas.', 'success');
  } catch (error) {
    feedback.textContent = error.message || 'No se pudieron guardar las preferencias.';
    notifyApp(feedback.textContent, 'error');
  } finally {
    save.disabled = false;
  }
});

document.querySelector('#logoutButton')?.addEventListener('click', () => logout());

const biometricsModal = document.querySelector('#biometricsModal');
const biometricForm = document.querySelector('#biometricsForm');
const biometricSource = document.querySelector('#biometricSource');
const biaFields = document.querySelector('#biometricBiaFields');
let biometricTrigger;

function updateBiometricSource() {
  if (!biaFields || !biometricSource) return;
  biaFields.hidden = biometricSource.value !== 'bia';
  biometricSource.setAttribute('aria-expanded', String(!biaFields.hidden));
}

async function loadBiometrics() {
  const tableBody = document.querySelector('#biometricsTableBody');
  if (!tableBody) return;
  tableBody.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/biometrics', { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const { records } = await response.json();
    tableBody.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      appendPlainText(empty, 'Sin registros biométricos todavía. Registra el peso aquí y agrega tu estatura en Perfil de cuenta para disponer de una ');
      empty.append(createTermHelp('TMB', tmbExplanation));
      appendPlainText(empty, ' estimada por ');
      empty.append(createTermHelp('Mifflin', mifflinExplanation));
      appendPlainText(empty, '.');
      tableBody.append(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'biometric-records-table';
    const labels = ['Fecha', 'Fuente', 'Edad corporal', 'Grasa %', 'RM kcal', 'Grasa visceral', 'IMC', 'Peso kg', 'Músculo %'];
    const header = table.createTHead().insertRow();
    labels.forEach((label) => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; header.append(cell); });
    const body = table.createTBody();
    for (const record of records) {
      const row = body.insertRow();
      const values = [record.measuredAt, null, record.bodyAge, record.bodyFatPct, record.restingMetabolismKcal, record.visceralFat, record.bmi, record.weightKg, record.musclePct];
      for (const [index, value] of values.entries()) {
        const cell = row.insertCell();
        if (index === 1 && record.source === 'mifflin') {
          appendPlainText(cell, 'Manual · ');
          cell.append(createTermHelp('Mifflin', mifflinExplanation));
          appendPlainText(cell, ' (estimado)');
        } else if (index === 1) cell.textContent = record.source === 'bia' ? 'BIA' : 'Manual';
        else cell.textContent = value == null || value === '' ? '—' : String(value);
      }
    }
    tableBody.append(table);
    if (!records.some((record) => record.restingMetabolismKcal != null)) {
      const hint = document.createElement('div');
      hint.className = 'hint';
      appendPlainText(hint, 'Aún no hay ');
      hint.append(createTermHelp('TMB', tmbExplanation));
      appendPlainText(hint, '. Registra peso biométrico y estatura en Perfil de cuenta; ');
      hint.append(createTermHelp('Mifflin', mifflinExplanation));
      appendPlainText(hint, ' usa edad y sexo del perfil.');
      tableBody.append(hint);
    }
  } catch {
    tableBody.textContent = 'No se pudieron cargar las mediciones.';
    notifyApp('No se pudieron cargar las mediciones.', 'error');
  } finally {
    tableBody.setAttribute('aria-busy', 'false');
  }
}

function openBiometrics(event) {
  if (!biometricsModal) return;
  biometricTrigger = event.currentTarget;
  if (!biometricsModal.open) biometricsModal.showModal();
  updateBiometricSource();
  document.querySelector('#biometricWeight').focus();
  loadBiometrics();
}

function closeBiometrics() {
  if (biometricsModal?.open) biometricsModal.close();
  biometricTrigger?.focus();
}

document.querySelector('#moreBiometricsButton')?.addEventListener('click', openBiometrics);
document.querySelector('#closeBiometricsModal')?.addEventListener('click', closeBiometrics);
biometricsModal?.addEventListener('click', (event) => { if (event.target === biometricsModal) closeBiometrics(); });
biometricSource?.addEventListener('change', updateBiometricSource);
biometricForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = document.querySelector('#biometricsFormFeedback');
  feedback.textContent = '';
  const isBia = biometricSource.value === 'bia';
  const value = (id) => document.querySelector(`#${id}`).value;
  try {
    const response = await fetch('/api/biometrics', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: biometricSource.value, weightKg: value('biometricWeight'),
        bodyAge: isBia ? value('biometricBodyAge') : '', bodyFatPct: isBia ? value('biometricBodyFat') : '',
        restingMetabolismKcal: isBia ? value('biometricBmr') : '', visceralFat: isBia ? value('biometricVisceral') : '',
        bmi: isBia ? value('biometricBmi') : '', musclePct: isBia ? value('biometricMuscle') : '', notes: value('biometricNotes'),
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || 'No se pudo guardar la medición.');
    }
    biometricForm.reset();
    updateBiometricSource();
    await loadBiometrics();
    await loadAccountProfile();
    feedback.textContent = result.tmbStatus === 'created' ? 'Registro biométrico guardado; se agregó una estimación del metabolismo basal.' : 'Registro biométrico guardado.';
    notifyApp(feedback.textContent, 'success');
  } catch (error) {
    feedback.textContent = error.message || 'No se pudo guardar la medición.';
    notifyApp(feedback.textContent, 'error');
  }
});

const plicometroModal = document.querySelector('#plicometroModal');
const plicometroForm = document.querySelector('#plicometroForm');
let plicometroTrigger;
const plicometroFields = [
  ['tricepsMm', 'Tríceps'], ['bicepsMm', 'Bíceps'], ['subescapularMm', 'Subescapular'],
  ['suprailiacoMm', 'Suprailíaco'], ['abdominalMm', 'Abdominal'], ['musloAnteriorMm', 'Muslo anterior'],
  ['pantorrillaMm', 'Pantorrilla'],
];
const localDate = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

async function loadPlicometrics() {
  const tableBody = document.querySelector('#plicometroTableBody');
  tableBody.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/plicometrics', { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const { records } = await response.json();
    tableBody.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Todavía no hay mediciones de plicómetro.';
      tableBody.append(empty);
      return;
    }
    const table = document.createElement('table');
    table.className = 'biometric-records-table';
    const headings = ['Fecha', ...plicometroFields.map(([, label]) => `${label} mm`)];
    const header = table.createTHead().insertRow();
    headings.forEach((label) => { const cell = document.createElement('th'); cell.scope = 'col'; cell.textContent = label; header.append(cell); });
    const body = table.createTBody();
    for (const record of records) {
      const row = body.insertRow();
      for (const value of [record.fecha, ...plicometroFields.map(([key]) => record[key])]) {
        row.insertCell().textContent = value == null || value === '' ? '—' : String(value);
      }
    }
    tableBody.append(table);
  } catch {
    tableBody.textContent = 'No se pudieron cargar las mediciones de plicómetro.';
    notifyApp('No se pudieron cargar las mediciones de plicómetro.', 'error');
  } finally {
    tableBody.setAttribute('aria-busy', 'false');
  }
}

document.querySelector('#morePlicometroButton')?.addEventListener('click', (event) => {
  plicometroTrigger = event.currentTarget;
  document.querySelector('#plicometroDate').value = document.querySelector('#daySelect')?.value || localDate();
  plicometroModal.showModal();
  document.querySelector('#plicometroDate').focus();
  loadPlicometrics();
});
const closePlicometro = () => plicometroModal.close();
document.querySelector('#closePlicometroModal')?.addEventListener('click', closePlicometro);
document.querySelector('#cancelPlicometroModal')?.addEventListener('click', closePlicometro);
plicometroModal?.addEventListener('close', () => plicometroTrigger?.focus());
plicometroForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const feedback = document.querySelector('#plicometroFormFeedback');
  const submit = plicometroForm.querySelector('button[type="submit"]');
  feedback.textContent = '';
  submit.disabled = true;
  try {
    const value = (id) => document.querySelector(`#plicometro${id}`).value;
    const response = await fetch('/api/plicometrics', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fecha: value('Date'), tricepsMm: value('Triceps'), bicepsMm: value('Biceps'),
        subescapularMm: value('Subescapular'), suprailiacoMm: value('Suprailiaco'),
        abdominalMm: value('Abdominal'), musloAnteriorMm: value('Muslo'), pantorrillaMm: value('Pantorrilla'),
      }),
    });
    if (!response.ok) throw new Error((await response.json()).error || 'No se pudo guardar el registro.');
    plicometroForm.reset();
    document.querySelector('#plicometroDate').value = document.querySelector('#daySelect')?.value || localDate();
    feedback.textContent = 'Registro de plicómetro guardado.';
    await loadPlicometrics();
    notifyApp(feedback.textContent, 'success');
  } catch (error) {
    feedback.textContent = error.message || 'No se pudo guardar el registro.';
    notifyApp(feedback.textContent, 'error');
  } finally {
    submit.disabled = false;
  }
});

const trainingDialog = document.querySelector('#trainingModal');
const trainingTrigger = document.querySelector('#addTrainingButton');
const trainingInput = document.querySelector('#trainingDescription');
const trainingAnalyzeButton = document.querySelector('#trainingAnalyzeButton');
const trainingLoading = document.querySelector('#trainingLoading');
const trainingLoadingText = document.querySelector('#trainingLoadingText');
const trainingFeedback = document.querySelector('#trainingFeedback');
const trainingChatMessages = document.querySelector('#trainingChatMessages');
const syncGarminTrainingButton = document.querySelector('#syncGarminTrainingButton');
const trainingModeToggle = document.querySelector('#trainingModeToggle');
const trainingDescriptionFields = document.querySelector('#trainingDescriptionFields');
let trainingOpenGeneration = 0;
let trainingSessionReady = false;
let trainingSessionUiInitialized = false;
let trainingPending = false;
let trainingSavedAt = null;
let trainingGarminConnected = false;
const trainingModeStorageKey = 'nutriTrainingMode';
function savedTrainingMode() {
  try { return localStorage.getItem(trainingModeStorageKey) === 'garmin' ? 'garmin' : 'description'; }
  catch { return 'description'; }
}
function updateTrainingMode() {
  const useGarmin = trainingGarminConnected && document.querySelector('[name="trainingMode"]:checked')?.value === 'garmin';
  trainingAnalyzeButton.hidden = useGarmin;
  syncGarminTrainingButton.hidden = !useGarmin;
  trainingDescriptionFields.hidden = useGarmin;
  const prompt = document.querySelector('#trainingInitialPrompt');
  if (prompt) prompt.textContent = useGarmin
    ? 'Cuéntame qué entrenamiento hiciste. Por ejemplo: actividad, tiempo, distancia e intensidad.'
    : 'Cuéntame qué entrenamiento hiciste. Por ejemplo: actividad, tiempo, distancia e intensidad. También puedes agregar los pasos totales dados hoy; se guardarán aparte.';
}
async function showGarminTrainingSync(generation) {
  syncGarminTrainingButton.hidden = true;
  trainingModeToggle.hidden = true;
  try {
    const response = await fetch('/api/onboarding/preferences', { credentials: 'same-origin' });
    if (!response.ok) return;
    const { preferences } = await response.json();
    if (generation === trainingOpenGeneration) {
      trainingGarminConnected = preferences?.garminConnected === true && preferences.deviceMode === 'garmin';
      trainingModeToggle.hidden = !trainingGarminConnected;
      updateTrainingMode();
    }
  } catch {}
}
async function prepareTrainingSessionUi(generation) {
  trainingAnalyzeButton.disabled = true;
  trainingInput.disabled = true;
  trainingLoading.hidden = false;
  trainingLoadingText.textContent = 'Preparando sesión…';
  trainingFeedback.textContent = 'Preparando la sesión de entrenamiento…';
  notifyApp('Preparando la sesión de entrenamiento.', 'info');
  try {
    const response = await fetch('/api/training/session', { method: 'POST', credentials: 'same-origin' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo preparar la sesión de entrenamiento.');
    if (generation !== trainingOpenGeneration) return;
    trainingSessionReady = true;
    trainingFeedback.textContent = 'Sesión lista.';
    trainingFeedback.classList.remove('food-session-error');
    notifyApp(trainingFeedback.textContent, 'success');
  } catch {
    if (generation !== trainingOpenGeneration) return;
    trainingSessionReady = false;
    trainingFeedback.textContent = 'No se pudo abrir la sesión de entrenamiento';
    trainingFeedback.classList.add('food-session-error');
    notifyApp(trainingFeedback.textContent, 'error');
  } finally {
    if (generation === trainingOpenGeneration) {
      trainingSessionUiInitialized = trainingSessionReady;
      trainingLoading.hidden = true;
      trainingAnalyzeButton.disabled = !trainingSessionReady;
      trainingInput.disabled = !trainingSessionReady;
      if (trainingSessionReady && trainingDialog.open) trainingInput.focus();
    }
  }
}
trainingTrigger?.addEventListener('click', () => {
  if (trainingPending || trainingSessionUiInitialized) { trainingDialog?.showModal(); return; }
  trainingSessionUiInitialized = true;
  const generation = ++trainingOpenGeneration;
  trainingSessionReady = false;
  trainingSavedAt = null;
  trainingInput.value = '';
  trainingInput.disabled = true;
  trainingFeedback.classList.remove('food-session-error');
  trainingGarminConnected = false;
  document.querySelector(`[name="trainingMode"][value="${savedTrainingMode()}"]`).checked = true;
  updateTrainingMode();
  trainingFeedback.textContent = '';
  trainingChatMessages.replaceChildren();
  appendTrainingMessage('assistant', 'Cuéntame qué entrenamiento hiciste. Por ejemplo: actividad, tiempo, distancia e intensidad.');
  document.querySelector('#trainingChatMessages .food-chat-message:first-child .food-chat-text').id = 'trainingInitialPrompt';
  updateTrainingMode();
  trainingDialog?.showModal();
  void showGarminTrainingSync(generation);
  void prepareTrainingSessionUi(generation);
});
trainingModeToggle?.addEventListener('change', (event) => {
  try { localStorage.setItem(trainingModeStorageKey, event.target.value); } catch {}
  updateTrainingMode();
});
syncGarminTrainingButton?.addEventListener('click', async () => {
  const date = dayInput?.value || localDate();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  syncGarminTrainingButton.disabled = true;
  trainingFeedback.textContent = `Consultando actividades Garmin del ${date}…`;
  notifyApp(trainingFeedback.textContent, 'info');
  try {
    const response = await fetch('/api/integrations/garmin/sync', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Client-Timezone': timezone },
      body: JSON.stringify({ date }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudieron sincronizar las actividades Garmin.');
    await loadTrainingEntries(date);
    await loadDailySteps(date);
    const activityMessage = result.saved
      ? `Se guardaron ${result.saved} actividad${result.saved === 1 ? '' : 'es'} Garmin${result.skipped ? `; ${result.skipped} ya estaban guardadas o no se pudieron importar` : ''}.`
      : result.activities ? 'Las actividades Garmin de este día ya estaban guardadas o no tenían datos importables.' : 'Garmin no tiene actividades para este día.';
    const stepsMessages = [
      result.stepsUpdated ? `Pasos Garmin guardados o actualizados para ${result.stepsUpdated} fecha${result.stepsUpdated === 1 ? '' : 's'}.` : '',
      result.stepsUnavailable ? `Garmin no devolvió pasos para ${result.stepsUnavailable} fecha${result.stepsUnavailable === 1 ? '' : 's'}.` : '',
    ].filter(Boolean);
    const message = `${activityMessage}${stepsMessages.length ? ` ${stepsMessages.join(' ')}` : ''}`;
    appendTrainingMessage('assistant', message);
    trainingFeedback.textContent = message;
    notifyApp(message, 'success');
  } catch (error) {
    trainingFeedback.textContent = error.message || 'No se pudieron sincronizar las actividades Garmin.';
    appendTrainingMessage('error', trainingFeedback.textContent);
    notifyApp(trainingFeedback.textContent, 'error');
  } finally { syncGarminTrainingButton.disabled = false; }
});
document.querySelector('#closeTrainingModal')?.addEventListener('click', () => trainingDialog?.close());
document.querySelector('#cancelTrainingModal')?.addEventListener('click', () => trainingDialog?.close());
trainingDialog?.addEventListener('close', () => trainingTrigger?.focus());
function appendTrainingMessage(role, content) {
  const bubble = document.createElement('div');
  bubble.className = 'food-chat-message';
  bubble.dataset.role = role;
  const speaker = document.createElement('span');
  speaker.className = 'food-chat-speaker';
  speaker.textContent = role === 'user' ? 'Tú' : role === 'error' ? 'Error' : 'Asistente';
  const text = document.createElement('p');
  text.className = 'food-chat-text';
  text.textContent = content;
  bubble.append(speaker, text);
  trainingChatMessages.append(bubble);
  trainingChatMessages.parentElement.scrollTop = trainingChatMessages.parentElement.scrollHeight;
  return bubble;
}
trainingAnalyzeButton?.addEventListener('click', async () => {
  const generation = trainingOpenGeneration;
  const description = trainingInput.value.trim();
  if (!description || trainingAnalyzeButton.disabled || trainingPending) { if (!description) trainingFeedback.textContent = 'Describe el entrenamiento para continuar.'; return; }
  trainingPending = true;
  trainingTrigger.setAttribute('aria-busy', 'true');
  document.querySelector('#trainingButtonLoading').hidden = false;
  trainingFeedback.textContent = 'Enviando la descripción…';
  trainingLoading.hidden = false;
  trainingLoadingText.textContent = 'Analizando entrenamiento…';
  trainingInput.disabled = true;
  trainingAnalyzeButton.disabled = true;
  appendTrainingMessage('user', description);
  trainingInput.value = '';
  notifyApp('Analizando el entrenamiento.', 'info');
  try {
    const response = await fetch('/api/training-analysis', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone },
      body: JSON.stringify({ description, suppressNotification: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo analizar el entrenamiento.');
    if (generation !== trainingOpenGeneration) return;
    const analysis = result.analysis;
    if (analysis.stepsSaved) {
      const stepsMessage = `${new Intl.NumberFormat('es-MX').format(analysis.stepsSaved.stepsCount)} pasos guardados para ${analysis.stepsSaved.date}.`;
      appendTrainingMessage('assistant', stepsMessage);
      notifyApp(stepsMessage, 'success');
      void loadDailySteps(analysis.stepsSaved.date);
    }
    if (!analysis.trainingSession) {
      trainingFeedback.textContent = analysis.stepsSaved ? 'Pasos guardados; no se registró una sesión ni se estimaron calorías.' : 'No se registró una sesión de entrenamiento.';
      await notifyResultIfHidden(trainingDialog, 'entrenamiento', 'generado', 'Resultado del entrenamiento', trainingFeedback.textContent);
      return;
    }
    if (analysis.saveTimeStatus === 'invalid') throw new Error('La hora indicada no es válida.');
    if (analysis.saveTimeStatus === 'specified') trainingSavedAt = analysis.requestedSaveTime;
    const context = analysis.biometricContext;
    const profile = [
      context.latestWeightKg == null ? '' : `Peso registrado: ${context.latestWeightKg} kg${context.weightMeasuredAt ? ` (${context.weightMeasuredAt})` : ''}`,
      context.registeredHeightCm == null ? '' : `Estatura registrada: ${context.registeredHeightCm} cm`,
    ].filter(Boolean).join(' · ');
    const message = analysis.caloriesKcal == null ? analysis.question
      : `Gasto estimado: ~${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 }).format(analysis.caloriesKcal)} kcal.\n${analysis.activity} · ${analysis.durationMinutes} min · ${analysis.weightKg} kg · ${analysis.met} MET.\nFórmula: ${analysis.formula}${profile ? `\nContexto del perfil: ${profile}` : ''}`;
    if (message) appendTrainingMessage('assistant', message);
    if (analysis.saveTimeStatus === 'ambiguous') {
      appendTrainingMessage('assistant', 'Indica la hora con a. m./p. m. o en formato de 24 horas para guardarla correctamente.');
      trainingFeedback.textContent = 'Aclara la hora de guardado; todavía no se guardó el entrenamiento.';
      trainingInput.value = description;
      await notifyResultIfHidden(trainingDialog, 'entrenamiento', 'requiere_respuesta', 'Entrenamiento: falta la hora', 'Indica la hora para guardar la sesión.', null);
      return;
    }
    if (analysis.caloriesKcal == null) {
      trainingFeedback.textContent = analysis.question || 'Falta un dato para completar el análisis.';
      await notifyResultIfHidden(trainingDialog, 'entrenamiento', 'requiere_respuesta', 'Entrenamiento: falta una aclaración', trainingFeedback.textContent);
      return;
    }
    trainingLoadingText.textContent = 'Guardando entrenamiento…';
    trainingFeedback.textContent = 'Guardando el entrenamiento…';
    const nutritionDate = dayInput?.value || localDate();
    const saveResponse = await fetch('/api/training-entries', {
      method: 'POST', credentials: 'same-origin', headers: {
        'Content-Type': 'application/json', 'X-Client-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      body: JSON.stringify({ description, analysis, savedAt: trainingSavedAt, date: nutritionDate, suppressNotification: true }),
    });
    const saved = await saveResponse.json();
    if (!saveResponse.ok) throw new Error(saved.error || 'No se pudo guardar el entrenamiento.');
    await loadTrainingEntries(nutritionDate);
    trainingSavedAt = null;
    trainingFeedback.textContent = saved.savedAt ? `Entrenamiento analizado y guardado a las ${saved.savedAt}.` : 'Entrenamiento analizado y guardado.';
    notifyApp(trainingFeedback.textContent, 'success');
    await notifyResultIfHidden(trainingDialog, 'entrenamiento', 'guardado', 'Entrenamiento guardado', trainingFeedback.textContent);
  } catch (error) {
    if (generation !== trainingOpenGeneration) return;
    trainingInput.value = description;
    appendTrainingMessage('error', error.message || 'No se pudo analizar el entrenamiento.');
    trainingFeedback.textContent = error.message || 'No se pudo analizar el entrenamiento.';
    notifyApp(trainingFeedback.textContent, 'error');
    await notifyResultIfHidden(trainingDialog, 'entrenamiento', 'error', 'No se pudo completar el entrenamiento', trainingFeedback.textContent);
  } finally {
    trainingPending = false;
    trainingTrigger.setAttribute('aria-busy', 'false');
    document.querySelector('#trainingButtonLoading').hidden = true;
    if (generation === trainingOpenGeneration) {
      trainingLoading.hidden = true;
      trainingInput.disabled = false;
      trainingAnalyzeButton.disabled = !trainingSessionReady;
      if (trainingDialog.open) trainingInput.focus();
    }
  }
});

const foodDialog = document.querySelector('#registerFoodDialog');
const foodForm = document.querySelector('#registerFoodForm');
let foodTrigger;
let foodEntryDate = '';
const foodDate = () => foodEntryDate || document.querySelector('#daySelect')?.value || localDate();
let foodRequestId = '';
let foodTargetEntryId = null;
let foodPending = false;
let foodSessionReady = false;
let foodAudioContext;

function unlockFoodAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return Promise.resolve();
    foodAudioContext ||= new AudioContext();
    return foodAudioContext.resume().catch(() => {});
  } catch { return Promise.resolve(); }
}

function playFoodAddedSound() {
  try {
    if (foodAudioContext?.state !== 'running') return;
    const oscillator = foodAudioContext.createOscillator();
    const gain = foodAudioContext.createGain();
    const now = foodAudioContext.currentTime;
    oscillator.frequency.value = 880;
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.08, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    oscillator.connect(gain);
    gain.connect(foodAudioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.19);
  } catch {}
}

function appendFoodChatMessage(role, content) {
  document.querySelector('#foodChatThread').hidden = false;
  const chat = document.querySelector('#foodChatMessages');
  chat.hidden = false;
  const isError = role === 'assistant' && content.startsWith('[ERROR_REGISTRO] ');
  if (isError) { role = 'error'; content = content.slice('[ERROR_REGISTRO] '.length); }
  const bubble = document.createElement('div');
  bubble.className = 'food-chat-message';
  bubble.dataset.role = role;
  if (role === 'error') bubble.setAttribute('aria-live', 'assertive');
  const speaker = document.createElement('span');
  speaker.className = 'food-chat-speaker';
  speaker.textContent = role === 'user' ? 'Tú' : role === 'error' ? 'Error' : 'Asistente';
  const text = document.createElement('p');
  text.className = 'food-chat-text';
  text.textContent = content;
  bubble.append(speaker, text);
  chat.append(bubble);
  const thread = document.querySelector('#foodChatThread');
  thread.scrollTop = thread.scrollHeight;
  return bubble;
}

function renderFoodChat(messages) {
  const chat = document.querySelector('#foodChatMessages');
  chat.replaceChildren();
  const thread = document.querySelector('#foodChatThread');
  thread.hidden = !messages.length && document.querySelector('#foodLoading').hidden;
  for (const message of messages) appendFoodChatMessage(message.role, message.content);
  thread.scrollTop = thread.scrollHeight;
}

async function restoreFoodDraft(feedback) {
  const response = await fetch('/api/food-entries/pending', { credentials: 'same-origin' });
  if (!response.ok) {
    const error = await response.json().catch(() => null);
    throw new Error(error?.error || 'No se pudo recuperar el borrador de comida.');
  }
  const { draft } = await response.json();
  const description = document.querySelector('#foodDescription');
  const label = document.querySelector('#foodDescriptionLabel');
  const save = document.querySelector('#saveFoodButton');
  if (draft) {
    foodRequestId = draft.requestId;
    foodEntryDate = draft.fecha;
    foodTargetEntryId = draft.targetEntryId || null;
    renderFoodChat(draft.messages || []);
    document.querySelector('#foodEntryDate').textContent = `Borrador del día ${draft.fecha}; todavía no está guardado como comida.`;
    label.textContent = draft.question ? 'Tu respuesta' : 'Alimentos consumidos';
    description.placeholder = draft.question ? 'Responde la pregunta del asistente…' : 'Describe o corrige los alimentos…';
    save.textContent = 'Enviar mensaje';
    feedback.textContent = draft.question ? '' : 'Este borrador sigue pendiente; aún no se muestra como comida guardada.';
  } else {
    foodRequestId = createFoodRequestId();
    foodEntryDate = '';
    foodTargetEntryId = null;
    renderFoodChat([]);
    document.querySelector('#foodEntryDate').textContent = `Se guardará para el día ${foodDate()}.`;
    label.textContent = 'Alimentos consumidos';
    description.placeholder = 'Ej.: 150 g de pollo, 100 g de arroz cocido y 1 manzana';
    save.textContent = 'Enviar mensaje';
    feedback.textContent = 'Describe los alimentos; te pediré cualquier aclaración antes de guardarlos.';
  }
  return draft;
}

document.querySelector('#registerFoodButton')?.addEventListener('click', async (event) => {
  foodTrigger = event.currentTarget;
  const feedback = document.querySelector('#foodEntryFeedback');
  const foodLoading = document.querySelector('#foodLoading');
  const foodChatThread = document.querySelector('#foodChatThread');
  const description = document.querySelector('#foodDescription');
  const saveButton = document.querySelector('#saveFoodButton');
  if (!foodPending) {
    foodSessionReady = false;
    description.disabled = true;
    feedback.classList.remove('food-session-error');
  }
  foodLoading.hidden = false;
  document.querySelector('#foodLoadingText').textContent = foodPending ? 'Esperando respuesta…' : 'Preparando la sesión…';
  saveButton.disabled = true;
  foodForm.hidden = false;
  feedback.textContent = foodPending ? 'Esperando respuesta…' : 'Revisando borradores y preparando la sesión…';
  foodDialog.showModal();
  if (foodPending) return;
  foodChatThread.hidden = false;
  notifyApp('Preparando la sesión de comida…', 'info');
  try {
    await restoreFoodDraft(feedback);
    const response = await fetch('/api/food/session', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json()).error || 'No se pudo preparar una sesión nueva de comida.');
    foodSessionReady = true;
    notifyApp('Sesión de comida lista.', 'success');
    description.disabled = false;
    saveButton.disabled = false;
    description.focus();
  } catch (error) {
    foodSessionReady = false;
    description.disabled = true;
    saveButton.disabled = true;
    feedback.textContent = error instanceof Error ? error.message : 'No se pudo abrir la sesión de comidas';
    feedback.classList.add('food-session-error');
    notifyApp(feedback.textContent, 'error');
  } finally {
    foodLoading.hidden = true;
    foodChatThread.hidden = !document.querySelector('#foodChatMessages').children.length;
    saveButton.disabled = !foodSessionReady;
  }
});
const closeFoodDialog = () => foodDialog.close();
document.querySelector('#closeFoodDialog')?.addEventListener('click', closeFoodDialog);
document.querySelector('#cancelFoodEntry')?.addEventListener('click', closeFoodDialog);
foodDialog?.addEventListener('close', () => foodTrigger?.focus());
foodForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (foodPending || !foodSessionReady) return;
  const feedback = document.querySelector('#foodEntryFeedback');
  const saveButton = document.querySelector('#saveFoodButton');
  const foodLoading = document.querySelector('#foodLoading');
  const registerFoodButton = document.querySelector('#registerFoodButton');
  const description = document.querySelector('#foodDescription');
  const text = description.value.trim();
  if (!text) return;
  const audioReady = unlockFoodAudio();
  const body = { requestId: foodRequestId, fecha: foodDate(), descripcion: text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, targetEntryId: foodTargetEntryId, suppressNotification: true };
  let draftRestored = false;
  let resultNotificationHandled = false;
  foodPending = true;
  description.value = '';
  description.disabled = true;
  const pendingMessage = appendFoodChatMessage('user', text);
  feedback.textContent = 'Enviando la descripción…';
  foodLoading.hidden = false;
  document.querySelector('#foodLoadingText').textContent = 'Analizando los alimentos…';
  const foodChatThread = document.querySelector('#foodChatThread');
  foodChatThread.hidden = false;
  foodChatThread.scrollTop = foodChatThread.scrollHeight;
  registerFoodButton.setAttribute('aria-busy', 'true');
  document.querySelector('#foodButtonLoading').hidden = false;
  saveButton.disabled = true;
  try {
    const response = await fetch('/api/food-entries', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) {
      resultNotificationHandled = true;
      await notifyResultIfHidden(foodDialog, 'comida', 'error', 'No se pudo completar el registro de comida', result.message || result.error || 'Revisa el registro e inténtalo de nuevo.', result.entryId || null);
      if (result.entryId && result.requestId) {
        foodRequestId = result.requestId;
        foodTargetEntryId = result.targetEntryId || foodTargetEntryId;
        const draft = await restoreFoodDraft(feedback);
        draftRestored = Boolean(draft?.messages?.some((message) => message.role === 'assistant' && message.content.startsWith('[ERROR_REGISTRO] ')));
      } else {
        pendingMessage.remove();
        description.value = text;
      }
      throw new Error(result.error || result.message || 'No se pudo guardar la comida.');
    }
    pendingMessage.remove();
    renderFoodChat(result.messages || []);
    if (result.state === 'requiere_aclaracion') {
      foodRequestId = result.requestId;
      foodEntryDate = foodDate();
      foodTargetEntryId = result.targetEntryId ?? null;
      document.querySelector('#foodDescriptionLabel').textContent = 'Tu respuesta';
      description.placeholder = 'Responde la pregunta…';
      saveButton.textContent = 'Enviar mensaje';
      feedback.textContent = '';
      resultNotificationHandled = true;
      await notifyResultIfHidden(foodDialog, 'comida', 'requiere_respuesta', 'Comida: falta una aclaración', result.question || result.message, result.entryId);
    } else {
      if (result.appended) { await audioReady; playFoodAddedSound(); }
      await loadFoodEntries(foodDate());
      foodRequestId = createFoodRequestId();
      foodEntryDate = foodDate();
      foodTargetEntryId = result.entryId;
      document.querySelector('#foodDescriptionLabel').textContent = 'Agregar o corregir alimentos';
      description.placeholder = 'Indica qué alimento agregar o corregir en esta comida…';
      saveButton.textContent = 'Enviar mensaje';
      feedback.textContent = `${result.message || 'Comida guardada.'} Puedes agregar alimentos o corregirlos; cierra el registro para empezar otra comida.`;
      notifyApp(feedback.textContent, 'success');
      resultNotificationHandled = true;
      await notifyResultIfHidden(foodDialog, 'comida', 'guardado', 'Comida guardada', result.message || 'El registro de comida quedó guardado.', result.entryId);
    }
  } catch (error) {
    if (pendingMessage.isConnected) {
      pendingMessage.remove();
      description.value = text;
    }
    feedback.textContent = error.message || 'No se pudo guardar la comida.';
    if (!draftRestored) appendFoodChatMessage('error', feedback.textContent);
    notifyApp(feedback.textContent, 'error');
    if (!draftRestored && !resultNotificationHandled) await notifyResultIfHidden(foodDialog, 'comida', 'error', 'No se pudo completar el registro de comida', feedback.textContent, foodTargetEntryId);
  } finally {
    foodPending = false;
    foodLoading.hidden = true;
    document.querySelector('#foodChatThread').hidden = !document.querySelector('#foodChatMessages').children.length;
    registerFoodButton.setAttribute('aria-busy', 'false');
    document.querySelector('#foodButtonLoading').hidden = true;
    description.disabled = false;
    saveButton.disabled = false;
  }
});

async function decideTerms(decision) {
  const message = document.querySelector('#termsError');
  message.textContent = '';
  try {
    const response = await fetch('/api/terms/decision', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
    if (!response.ok) throw new Error('No se pudo guardar la decisión. Intenta de nuevo.');
    navigateWithNotice('Decisión guardada.', decision === 'accepted' ? '/dashboard_nutricional.html' : '/login.html');
  } catch (error) {
    message.textContent = error.message || 'No se pudo guardar la decisión.';
    notifyApp(message.textContent, 'error');
  }
}

document.querySelector('#acceptTermsButton')?.addEventListener('click', () => decideTerms('accepted'));
document.querySelector('#rejectTermsButton')?.addEventListener('click', () => decideTerms('rejected'));

const deleteDialog = document.querySelector('#deleteAccountDialog');
document.querySelector('#deleteAccountButton')?.addEventListener('click', () => {
  document.querySelector('#deleteAccountPassword').value = demoPassword;
  deleteDialog?.showModal();
});
document.querySelector('#cancelDeleteAccount')?.addEventListener('click', () => deleteDialog?.close());
document.querySelector('#closeDeleteAccount')?.addEventListener('click', () => deleteDialog?.close());
document.querySelector('#deleteAccountForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#deleteAccountError');
  message.textContent = '';
  try {
    const response = await fetch('/api/auth/delete', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.querySelector('#deleteAccountPassword').value }),
    });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'No se pudo eliminar la cuenta.');
    }
    navigateWithNotice('Cuenta eliminada.', '/login.html');
  } catch (error) {
    message.textContent = error.message || 'No se pudo eliminar la cuenta. Intenta de nuevo.';
    notifyApp(message.textContent, 'error');
  }
});

const dashboardTabs = document.querySelectorAll('[data-dashboard-tab]');
const dashboardViews = document.querySelectorAll('[data-dashboard-view]');
if (dashboardTabs.length) {
  const params = new URLSearchParams(window.location.search || '');
  const showView = (view) => {
    dashboardTabs.forEach((button) => button.setAttribute('aria-current', String(button.dataset.dashboardTab === view ? 'page' : 'false')));
    dashboardViews.forEach((section) => { section.hidden = section.dataset.dashboardView !== view; });
    if (params.has('view')) {
      params.set('view', view);
      history.replaceState(null, '', `${location.pathname}?${params}`);
    }
  };
  const initialView = [...dashboardTabs].some((button) => button.dataset.dashboardTab === params.get('view')) ? params.get('view') : 'today';
  showView(initialView);
  dashboardTabs.forEach((button) => button.addEventListener('click', () => showView(button.dataset.dashboardTab)));
}

const dayInput = document.querySelector('#daySelect');
let nutritionDayReady = Promise.resolve();
if (dayInput) {
  const params = new URLSearchParams(window.location.search || '');
  const validDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  };
  const localToday = () => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  const requestedDate = validDate(params.get('date') || '') ? params.get('date') : localToday();
  dayInput.value = requestedDate;
  nutritionDayReady = fetch('/api/onboarding/preferences', { credentials: 'same-origin' }).then(async (response) => {
    if (!response.ok) return;
    const { preferences } = await response.json();
    const [hour, minute] = String(preferences?.nutritionDayStart || '').split(':').map(Number);
    if (dayInput.value !== localToday() || !Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const now = new Date();
    if (now.getHours() * 60 + now.getMinutes() >= hour * 60 + minute) return;
    now.setDate(now.getDate() - 1);
    dayInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const url = new URL(window.location.href);
    url.searchParams.set('date', dayInput.value);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }).catch(() => {});
  const navigateDate = (offset = 0) => {
    if (offset) {
      const date = new Date(`${dayInput.value}T12:00:00`);
      date.setDate(date.getDate() + offset);
      dayInput.value = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
    if (!validDate(dayInput.value)) return;
    const url = new URL(window.location.href);
    url.searchParams.set('date', dayInput.value);
    window.location.assign(`${url.pathname}${url.search}${url.hash}`);
  };
  dayInput.addEventListener('change', () => navigateDate());
  document.querySelector('#previousDayButton')?.addEventListener('click', () => navigateDate(-1));
  document.querySelector('#nextDayButton')?.addEventListener('click', () => navigateDate(1));
}

let currentFoodEntries = [];
let trainingManualNetCaloriesKcal = null;
let trainingGarminReportedCaloriesKcal = null;
let trainingAdjustmentCaloriesKcal = null;
let trainingGarminEnabled = false;
let trainingDaySelected = null;
let unresolvedTrainingDuplicates = 0;
let uncalculableManualTrainingRecords = 0;
let restingCaloriesKcal = null;
let restingCaloriesSource = null;

function renderTrainingEnergySummary(consumedCaloriesKcal) {
  const values = document.querySelector('#trainingEnergySummaryValues');
  if (!values) return;
  const totalExpense = restingCaloriesKcal == null || trainingAdjustmentCaloriesKcal == null ? null : restingCaloriesKcal + trainingAdjustmentCaloriesKcal;
  const balance = consumedCaloriesKcal == null || totalExpense == null ? null : consumedCaloriesKcal - totalExpense;
  const balanceLabel = balance == null ? 'Balance parcial' : balance < 0 ? 'Déficit parcial estimado' : balance > 0 ? 'Superávit parcial estimado' : 'Equilibrio parcial';
  const rows = [
    { label: 'Consumo registrado', amount: consumedCaloriesKcal },
    { term: 'tmb', amount: restingCaloriesKcal, source: restingCaloriesSource },
    { label: 'Ejercicio manual neto estimado', amount: trainingManualNetCaloriesKcal },
    ...(trainingGarminEnabled ? [{ label: 'Garmin reportado', amount: trainingGarminReportedCaloriesKcal }] : []),
    { label: trainingGarminEnabled ? 'Ajuste de ejercicio manual + Garmin' : 'Ajuste de ejercicio manual', amount: trainingAdjustmentCaloriesKcal },
    { label: 'Gasto parcial total', amount: totalExpense },
    { label: balanceLabel, amount: balance, isBalance: true },
  ];
  const format = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });
  values.replaceChildren(...rows.map((rowData) => {
    const item = document.createElement('div');
    item.className = 'training-energy-metric';
    const label = document.createElement('span');
    if (rowData.term === 'tmb') {
      label.append(createTermHelp('TMB', tmbExplanation));
      appendPlainText(label, ` (reposo${rowData.source === 'mifflin' ? ' · ' : rowData.source === 'bia' ? ' · BIA' : ''}`);
      if (rowData.source === 'mifflin') label.append(createTermHelp('Mifflin', mifflinExplanation));
      appendPlainText(label, ')');
    } else label.textContent = rowData.label;
    const value = document.createElement('strong');
    const amount = rowData.amount;
    value.textContent = amount == null ? '—' : `${format.format(rowData.isBalance && (balance < 0) ? Math.abs(amount) : amount)} kcal`;
    item.append(label, value);
    if (rowData.isBalance) item.dataset.kind = 'balance';
    return item;
  }));
  const warning = document.querySelector('#trainingEnergySummaryWarning');
  const notices = [
    unresolvedTrainingDuplicates ? `${unresolvedTrainingDuplicates} registros posibles duplicados no se acreditaron` : '',
    uncalculableManualTrainingRecords ? `${uncalculableManualTrainingRecords} sesiones manuales sin kcal calculables` : '',
  ].filter(Boolean);
  warning.textContent = notices.join(' · ');
  warning.hidden = notices.length === 0;
}

function renderMacroCards(records) {
  const cards = document.querySelector('#macroCards');
  if (!cards) return;
  const items = records.filter((record) => record.state === 'completado').flatMap((record) => record.items || []);
  const energyUnavailable = items.some((item) => item.basis !== 'per_portion' || item.energyKcal == null || !Number.isFinite(Number(item.energyKcal)));
  const consumedCaloriesKcal = items.length ? energyUnavailable ? null : items.reduce((sum, item) => sum + Number(item.energyKcal), 0) : 0;
  const metrics = [
    ['Proteína', 'proteinG', 'g', 'protein'],
    ['Carbohidratos', 'carbohydrateG', 'g', 'carbs'],
    ['Grasas', 'fatG', 'g', 'fat'],
    ['Calorías', 'energyKcal', 'kcal', 'kcal'],
  ];
  const format = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });
  cards.replaceChildren(...metrics.map(([label, key, unit, style]) => {
    const card = document.createElement('article');
    card.className = `panel macro-card macro-${style}`;
    const title = document.createElement('h3');
    title.className = 'macro-label';
    title.textContent = label;
    const reading = document.createElement('p');
    reading.className = 'macro-reading';
    const value = document.createElement('strong');
    value.className = 'macro-value';
    const unavailable = items.some((item) => item.basis !== 'per_portion' || item[key] == null || !Number.isFinite(Number(item[key])));
    const consumedValue = items.length ? unavailable ? null : items.reduce((sum, item) => sum + Number(item[key]), 0) : 0;
    value.textContent = consumedValue == null ? '—' : format.format(consumedValue);
    const measure = document.createElement('span');
    measure.className = 'macro-unit';
    measure.textContent = unit;
    const detail = document.createElement('span');
    detail.className = 'macro-detail';
    detail.textContent = items.some((item) => item.macroStatus === 'estimado') ? 'Incluye estimaciones' : 'Consumo registrado';
    const planMacroKey = { proteinG: 'proteinas_g', carbohydrateG: 'carbohidratos_g', fatG: 'grasas_g', energyKcal: 'calorias_kcal' }[key];
    const structuredTrainingTarget = trainingPlanTargets?.training && Object.values(trainingPlanTargets.training).some((value) => value !== null);
    const selectedTargets = trainingDaySelected === null ? null : trainingDaySelected && structuredTrainingTarget ? trainingPlanTargets?.training : trainingPlanTargets?.rest;
    const baseTarget = selectedTargets?.[planMacroKey];
    const exerciseAware = trainingDaySelected === true && !structuredTrainingTarget && (key === 'energyKcal' || key === 'carbohydrateG');
    const exerciseExtra = key === 'carbohydrateG' && trainingAdjustmentCaloriesKcal != null ? trainingAdjustmentCaloriesKcal / 4 : trainingAdjustmentCaloriesKcal;
    const targetValue = baseTarget == null || exerciseAware && exerciseExtra == null ? null : Number(baseTarget) + (exerciseAware ? exerciseExtra : 0);
    const planTarget = document.createElement('p');
    planTarget.className = 'macro-target';
    if (trainingDaySelected === null) {
      planTarget.dataset.status = 'incomplete';
      planTarget.textContent = 'Meta del plan no disponible: no se pudo determinar la actividad del día.';
    } else if (baseTarget == null) {
      planTarget.textContent = 'Meta diaria del plan: —';
    } else if (exerciseAware && exerciseExtra == null) {
      planTarget.dataset.status = 'incomplete';
      planTarget.textContent = `Meta base ${format.format(Number(baseTarget))} ${unit} · ajuste por ejercicio no disponible`;
    } else if (consumedValue == null) {
      planTarget.dataset.status = 'incomplete';
      planTarget.textContent = `${exerciseAware ? 'Meta ajustada' : 'Meta del plan'} ${format.format(targetValue)} ${unit} · No se puede comparar: faltan macros completos`;
    } else {
      const difference = Math.round((Number(targetValue) - consumedValue) * 10) / 10;
      planTarget.dataset.status = difference > 0 ? 'under' : difference < 0 ? 'over' : 'met';
      const comparison = difference > 0 ? `Restan ${format.format(difference)} ${unit}`
        : difference < 0 ? `Excedido ${format.format(Math.abs(difference))} ${unit}` : 'Meta alcanzada';
      const targetLabel = exerciseAware
        ? `Meta ajustada ${format.format(targetValue)} ${unit} (base ${format.format(Number(baseTarget))} ${unit} + ${format.format(trainingAdjustmentCaloriesKcal)} kcal${key === 'carbohydrateG' ? ' / 4' : ''})`
        : `Meta ${trainingDaySelected ? 'con entrenamiento' : 'en reposo'} ${format.format(targetValue)} ${unit}`;
      planTarget.textContent = `${targetLabel} · ${comparison}`;
    }
    reading.append(value, measure);
    card.append(title, reading, detail, planTarget);
    return card;
  }));
  renderTrainingEnergySummary(consumedCaloriesKcal);
}

function renderFoodEntries(records) {
  const list = document.querySelector('#foodEntriesList');
  if (!list) return;
  currentFoodEntries = records;
  renderMacroCards(records);
  list.replaceChildren();
  document.querySelector('#mealCount').textContent = String(records.length);
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No hay comidas guardadas para este día.';
    list.append(empty);
    return;
  }
  records.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  for (const [index, record] of records.entries()) {
    const card = document.createElement('article');
    card.className = 'meal';
    const header = document.createElement('div');
    header.className = 'meal-head';
    const title = document.createElement('h3');
    title.textContent = `Comida ${index + 1}`;
    const time = document.createElement('time');
    time.className = 'meal-time';
    time.dateTime = record.createdAt;
    time.textContent = `Registrado a las ${new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit' }).format(new Date(record.createdAt))}`;
    const headActions = document.createElement('div');
    headActions.className = 'meal-head-actions';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'meal-delete-button';
    remove.textContent = '−';
      remove.title = 'Eliminar comida y macros';
      remove.setAttribute('aria-label', 'Eliminar esta comida y todos sus alimentos y macros');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
          if (!await confirmRecordDelete('¿Eliminar esta comida y todos sus alimentos y macros?')) { remove.disabled = false; return; }
          const response = await fetch(`/api/food-entries/${encodeURIComponent(record.id)}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!response.ok) throw new Error((await response.json()).error || 'No se pudo eliminar la comida.');
        notifyApp('Comida, alimentos y macros eliminados.', 'success');
        await loadFoodEntries(record.fecha);
      } catch (error) {
        notifyApp(error.message || 'No se pudo eliminar la comida.', 'error');
        remove.disabled = false;
      }
    });
    headActions.append(time, remove);
    header.append(title, headActions);
    card.append(header);
    for (const item of record.items || []) {
      const food = document.createElement('div');
      food.className = 'meal-food';
      const name = document.createElement('h4');
      name.textContent = `${item.name}${item.quantity ? ` · ${item.quantity}` : ''}${item.basis === 'per_100g' ? ' · por 100 g' : ''}`;
      const macros = document.createElement('p');
      macros.className = 'meal-macros';
      macros.textContent = `Macros${item.macroStatus === 'estimado' ? ' estimados' : ''}: ${item.energyKcal} kcal · proteína ${item.proteinG} g · carbohidratos ${item.carbohydrateG} g · grasa ${item.fatG} g · fibra ${item.fiberG ?? '—'} g`;
      food.append(name, macros);
      if (item.macroSource === 'webfetch' && item.sourceName) {
        const source = document.createElement('details');
        source.className = 'meal-source';
        const summary = document.createElement('summary');
        summary.textContent = `Fuente consultada: ${item.sourceName}`;
        source.append(summary);
        if (item.sourceQuote) {
          const quote = document.createElement('p');
          quote.textContent = item.sourceQuote;
          source.append(quote);
        }
        try {
          const url = new URL(item.sourceUrl);
          if (url.protocol === 'https:' && !url.username && !url.password) {
            const link = document.createElement('a');
            link.href = url.href;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Abrir fuente';
            source.append(link);
          }
        } catch {}
        food.append(source);
      }
      card.append(food);
    }
    if (record.items?.length) {
      const total = document.createElement('div');
      total.className = 'meal-total';
      const title = document.createElement('h4');
      title.textContent = 'Total de esta comida';
      const macros = document.createElement('p');
      if (record.items.some((item) => item.basis !== 'per_portion')) {
        macros.textContent = 'No disponible: falta el gramaje consumido de algún alimento.';
      } else {
        const sum = (key) => {
          const values = record.items.map((item) => item[key] == null ? NaN : Number(item[key]));
          return values.every(Number.isFinite) ? new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(values.reduce((total, value) => total + value, 0)) : '—';
        };
        macros.textContent = `${sum('energyKcal')} kcal · proteína ${sum('proteinG')} g · carbohidratos ${sum('carbohydrateG')} g · grasa ${sum('fatG')} g · fibra ${sum('fiberG')} g`;
      }
      total.append(title, macros);
      card.append(total);
    }
    if (record.clarifications?.length) {
      const clarification = document.createElement('p');
      clarification.className = 'meal-clarification';
      clarification.textContent = `Aclaración guardada: ${record.clarifications.join(' · ')}`;
      card.append(clarification);
    }
    if (!record.items?.length) {
      const description = document.createElement('p');
      description.textContent = record.description;
      card.append(description);
    }
    list.append(card);
  }
}

async function loadFoodEntries(date = document.querySelector('#daySelect')?.value || localDate()) {
  const list = document.querySelector('#foodEntriesList');
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/food-entries?fecha=${encodeURIComponent(date)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const { records } = await response.json();
    if (!Array.isArray(records)) throw new Error();
    renderFoodEntries(records);
  } catch {
    list.textContent = 'No se pudieron cargar los alimentos guardados.';
    notifyApp('No se pudieron cargar los alimentos guardados.', 'error');
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

if (document.querySelector('#foodEntriesList')) nutritionDayReady.then(() => loadFoodEntries());

async function loadDailySteps(date = dayInput?.value || localDate()) {
  const count = document.querySelector('#dailyStepsCount');
  if (!count) return;
  const dateLabel = document.querySelector('#dailyStepsDate');
  if (dateLabel) {
    dateLabel.dateTime = date;
    dateLabel.textContent = new Intl.DateTimeFormat('es-MX', { timeZone: 'UTC', day: 'numeric', month: 'short' }).format(new Date(`${date}T12:00:00Z`));
  }
  count.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch(`/api/daily-steps?fecha=${encodeURIComponent(date)}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const result = await response.json();
    count.textContent = result.stepsCount == null ? '—' : new Intl.NumberFormat('es-MX').format(result.stepsCount);
  } catch {
    count.textContent = '—';
    notifyApp('No se pudieron cargar los pasos del día.', 'error');
  } finally { count.removeAttribute('aria-busy'); }
}

if (document.querySelector('#dailyStepsCount')) nutritionDayReady.then(() => loadDailySteps());

async function loadTrainingEntries(date = dayInput?.value || localDate()) {
  const list = document.querySelector('#trainingEntriesList');
  if (!list) return;
  list.setAttribute('aria-busy', 'true');
  try {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const response = await fetch(`/api/training-entries?fecha=${encodeURIComponent(date)}`, {
      credentials: 'same-origin', headers: { 'X-Client-Timezone': timezone },
    });
    if (!response.ok) throw new Error();
    const { records, exercise, garminEnabled } = await response.json();
    if (!Array.isArray(records)) throw new Error();
    trainingGarminEnabled = garminEnabled === true;
    trainingDaySelected = records.length > 0;
    trainingManualNetCaloriesKcal = Number(exercise?.manualNetKcal);
    trainingGarminReportedCaloriesKcal = Number(exercise?.deviceReportedKcal);
    trainingAdjustmentCaloriesKcal = Number(exercise?.adjustmentKcal);
    unresolvedTrainingDuplicates = Number(exercise?.unresolvedPossibleDuplicates) || 0;
    uncalculableManualTrainingRecords = Number(exercise?.uncalculableManualCount) || 0;
    if (![trainingManualNetCaloriesKcal, trainingGarminReportedCaloriesKcal, trainingAdjustmentCaloriesKcal].every(Number.isFinite)) throw new Error();
    renderMacroCards(currentFoodEntries);
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
       empty.textContent = 'No hay entrenamientos registrados para este día nutricional.';
      list.append(empty);
      return;
    }
    for (const record of records) {
      const card = document.createElement('article');
      card.className = 'meal';
      const header = document.createElement('div');
      header.className = 'meal-head';
      const title = document.createElement('h3');
      title.textContent = record.activity;
      const time = document.createElement('time');
      time.className = 'meal-time';
      time.dateTime = record.createdAt;
      time.textContent = `Registrado a las ${new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(record.createdAt))}`;
      const headActions = document.createElement('div');
      headActions.className = 'meal-head-actions';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'meal-delete-button';
      remove.textContent = '−';
      remove.title = 'Eliminar entrenamiento';
       remove.setAttribute('aria-label', 'Eliminar este entrenamiento guardado');
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try {
           if (!await confirmRecordDelete('¿Eliminar este entrenamiento guardado?')) { remove.disabled = false; return; }
          const response = await fetch(`/api/training-entries/${encodeURIComponent(record.id)}`, { method: 'DELETE', credentials: 'same-origin' });
          if (!response.ok) throw new Error((await response.json()).error || 'No se pudo eliminar el entrenamiento.');
          notifyApp('Entrenamiento eliminado.', 'success');
           const date = dayInput?.value || localDate();
            await loadTrainingEntries(date);
        } catch (error) {
          notifyApp(error.message || 'No se pudo eliminar el entrenamiento.', 'error');
          remove.disabled = false;
        }
      });
      headActions.append(time, remove);
      header.append(title, headActions);
      const details = document.createElement('div');
      details.className = 'meal-food';
      const description = document.createElement('h4');
      description.textContent = record.description;
      const metrics = document.createElement('p');
      metrics.className = 'meal-macros';
      metrics.textContent = record.energyType === 'reportada_dispositivo'
        ? `${record.durationMinutes} min${record.distanceMeters != null && Number.isFinite(Number(record.distanceMeters)) ? ` · ${(Number(record.distanceMeters) / 1000).toFixed(2)} km` : ''} · ${record.origin === 'garmin' ? 'Garmin Connect' : record.origin}`
        : `${record.durationMinutes} min · ${record.weightKg} kg · ${record.met} MET`;
      details.append(description, metrics);
      const total = document.createElement('div');
      total.className = 'meal-total';
      const label = document.createElement('h4');
      label.textContent = record.energyType === 'reportada_dispositivo' ? `Calorías reportadas por ${record.origin === 'garmin' ? 'Garmin' : record.origin}` : 'Gasto bruto estimado (MET)';
      const energy = document.createElement('p');
      energy.textContent = `${new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 }).format(record.caloriesKcal)} kcal`;
      total.append(label, energy);
      card.append(header, details, total);
      list.append(card);
    }
  } catch {
    trainingDaySelected = null;
    trainingGarminEnabled = false;
    trainingManualNetCaloriesKcal = null;
    trainingGarminReportedCaloriesKcal = null;
    trainingAdjustmentCaloriesKcal = null;
    unresolvedTrainingDuplicates = 0;
    uncalculableManualTrainingRecords = 0;
    renderMacroCards(currentFoodEntries);
    list.textContent = 'No se pudieron cargar los entrenamientos guardados.';
    notifyApp('No se pudieron cargar los entrenamientos guardados.', 'error');
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

if (document.querySelector('#trainingEntriesList')) nutritionDayReady.then(() => loadTrainingEntries());

async function loadAccountProfile() {
  const form = document.querySelector('#accountProfileForm');
  if (!form) return null;
  try {
    const response = await fetch('/api/dashboard/profile', { credentials: 'same-origin' });
    if (!response.ok) throw new Error();
    const { profile } = await response.json();
    if (profile.accountName) document.querySelector('#activeUserAccountName').textContent = profile.accountName;
    document.querySelector('#accountSexSelect').value = profile.sex || '';
    document.querySelector('#accountHeightCm').value = profile.heightCm ?? '';
    restingCaloriesKcal = profile.restingMetabolismKcal == null ? null : Number(profile.restingMetabolismKcal);
    restingCaloriesSource = profile.restingMetabolismSource;
    renderAccountTmbSummary(profile);
    renderMacroCards(currentFoodEntries);
    return profile;
  } catch {
    document.querySelector('#accountProfileFeedback').textContent = 'No se pudo cargar el perfil de cuenta.';
    restingCaloriesKcal = null;
    restingCaloriesSource = null;
    renderMacroCards(currentFoodEntries);
    notifyApp('No se pudo cargar el perfil de cuenta.', 'error');
    return null;
  }
}

if (document.querySelector('#accountProfileForm')) loadAccountProfile();

document.querySelector('#accountProfileForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const save = document.querySelector('#saveAccountProfileButton');
  const feedback = document.querySelector('#accountProfileFeedback');
  save.disabled = true;
  feedback.textContent = 'Guardando perfil de cuenta…';
  try {
    const response = await fetch('/api/dashboard/profile', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sex: form.querySelector('#accountSexSelect').value, heightCm: form.querySelector('#accountHeightCm').value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'No se pudo guardar el perfil.');
    await loadAccountProfile();
    feedback.textContent = result.tmbStatus === 'created' ? 'Perfil actualizado; se registró una estimación del metabolismo basal.'
      : result.tmbStatus === 'existing' ? 'Perfil actualizado; se conservó el metabolismo basal existente.'
        : result.tmbStatus === 'missing_data' ? 'Perfil actualizado; falta peso biométrico o estatura para estimar el metabolismo basal.'
          : result.tmbStatus === 'age_out_of_range' ? 'Perfil actualizado; la edad está fuera del rango admitido para estimar el metabolismo basal.'
            : result.tmbStatus === 'unsupported_sex' ? 'Perfil actualizado; el sexo registrado no es compatible con la estimación del metabolismo basal.'
              : 'Perfil actualizado.';
    notifyApp(feedback.textContent, 'success');
  } catch (error) {
    feedback.textContent = error.message || 'No se pudo guardar el perfil.';
    notifyApp(feedback.textContent, 'error');
  } finally {
    save.disabled = false;
  }
});
