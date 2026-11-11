const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

class Element {
  listeners = {};
  attributes = {};
  dataset = {};
  classList = { add() {}, remove() {}, toggle() {} };
  value = '';
  disabled = false;
  hidden = false;
  checked = false;
  textContent = '';

  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { this.reportedValidity = true; }
  isConnected = true;
  matches() { return false; }
  querySelector(selector) { return (this.queried ||= {})[selector] ||= new Element(); }
  querySelectorAll() { return []; }
  after() {}
  focus() { this.focused = true; }
  append(...children) { this.children = [...(this.children || []), ...children]; for (const child of children) child.parent = this; }
  replaceChildren(...children) { this.children = children; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  showPopover() { this.open = true; }
  hidePopover() { this.open = false; }
  dispatch(name) {
    const event = { currentTarget: this, preventDefault() { this.defaultPrevented = true; } };
    const results = (this.listeners[name] || []).map((listener) => listener(event));
    const pending = results.filter((result) => result && typeof result.then === 'function');
    return pending.length ? Promise.all(pending).then(() => event) : event;
  }
}

const settle = async () => { for (let turn = 0; turn < 10; turn += 1) await new Promise(setImmediate); };

function loadFlow(search = '', fetchOverride, options = {}) {
  const ids = [
    'loginForm', 'loginEmail', 'loginPassword', 'forgotPasswordButton', 'registerForm', 'errorMessage', 'cancelRegister',
    'recoveryRequestForm', 'recoveryEmail', 'cancelRecoveryRequest', 'resetPasswordForm', 'newPassword', 'confirmNewPassword', 'cancelPasswordReset',
    'registerName', 'registerCountryCode', 'registerEmail', 'registerCelular', 'registerPassword', 'registerHeight',
    'confirmPassword', 'registerAge', 'registerSex', 'preferencesForm', 'dietPattern', 'formError',
    'cancelPreferences',
    'deviceModeManual', 'deviceModeGarmin', 'integrationUsername', 'integrationPassword', 'integrationCredentialsSection', 'verifyGarminButton', 'integrationCredentialsNote', 'preferredFoods', 'avoidedFoods',
    'allergiesStatus', 'medicationsStatus', 'testDataNotice',
    'savePreferencesButton', 'continueButton', 'preferencesStep', 'preferencesTitle', 'preferencesIntro',
    'allergiesDetailsLabel', 'allergiesDetails', 'medicationsDetailsLabel', 'medicationsDetails',
    'morePreferencesButton', 'preferencesEditDialog', 'preferencesEditForm', 'savePreferencesEditButton', 'closeDeleteAccount',
    'deleteAccountDialog', 'deleteAccountButton', 'deleteAccountPassword', 'cancelDeleteAccount',
    'closePreferencesEdit', 'cancelPreferencesEdit', 'preferencesEditFeedback', 'editDietPattern',
    'editPreferredFoods', 'editAvoidedFoods', 'editAllergiesStatus', 'editAllergiesDetailsLabel', 'editAllergiesDetails',
    'editMedicationsStatus', 'editMedicationsDetailsLabel', 'editMedicationsDetails', 'editDeviceModeManual', 'editDeviceModeGarmin',
    'editGarminUsername', 'editGarminPassword', 'editGarminCredentialsSection', 'editGarminCredentialsNote', 'editVerifyGarminButton', 'editUnlinkGarminButton',
    'daySelect', 'previousDayButton', 'nextDayButton', 'registerFoodButton', 'foodButtonLoading', 'registerFoodDialog', 'registerFoodForm',
    'foodEntryDate', 'foodEntryFeedback', 'foodLoading', 'foodLoadingText', 'foodChatThread', 'foodChatMessages', 'foodDescriptionLabel', 'foodDescription', 'saveFoodButton',
    'appNoticeDialog', 'appNoticeText', 'foodButtonLoading', 'editUnitSystem',
    'chefDialog', 'chefForm', 'chefChatMessages', 'chefMessage', 'chefSendButton', 'chefLoading', 'chefFeedback', 'chefButton',
  ];
  const elements = { ...Object.fromEntries([...ids, ...(options.ids || [])].map((id) => [`#${id}`, new Element()])), ...options.elements };
  elements['.mode-buttons'] = new Element();
  elements['#testDataNotice'].hidden = true;
  const modeButtons = ['login', 'register'].map((mode) => {
    const button = new Element();
    button.dataset.mode = mode;
    return button;
  });
  const destinations = [];
  const requests = [];
  const defaultFetch = async (...request) => {
    requests.push(request);
    if (request[0] === '/api/auth/register') return { ok: true, json: async () => ({ ok: true }) };
    if (request[0].startsWith('/api/onboarding/preferences') && !request[1]?.method) return { ok: true, json: async () => ({ preferences: {
      deviceMode: search.includes('edit=1') ? 'garmin' : 'ninguno', garminConnected: search.includes('edit=1'), garminEmail: search.includes('edit=1') ? 'owner@example.com' : null,
      patronAlimentario: 'vegano', allergiesStatus: 'sin_informacion', medicationsStatus: 'sin_informacion',
    } }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const fetch = fetchOverride || defaultFetch;
  const document = {
    body: { dataset: { draftStorageScope: options.scope || 'a'.repeat(64) } },
    addEventListener() {},
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: (selector) => selector === '[data-mode]' ? modeButtons : [],
    createElement: () => new Element(),
  };
  const window = { fetch, addEventListener() {}, location: { href: `http://localhost/dashboard_nutricional.html${search}`, search, pathname: '/dashboard_nutricional.html', assign: (url) => destinations.push(url) } };
  const source = readFileSync(require.resolve('./onboarding-flow.js'), 'utf8');
  const testIntl = options.intl || { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'America/Mexico_City' }) }) };
  const storage = options.storage || new Map();
  const sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) };
  const context = vm.createContext({ document, window, fetch, Intl: testIntl, sessionStorage, AbortController, URL, URLSearchParams, navigator: { wakeLock: null }, setTimeout: options.setTimeout || ((callback, ms) => { if (ms <= 1500) setImmediate(callback); return 0; }), clearTimeout() {}, crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000', getRandomValues: (bytes) => bytes.fill(1) } });
  vm.runInContext(source, context);
  return { elements, modeButtons, destinations, requests, storage, evaluate: (code) => vm.runInContext(code, context) };
}

test('registration sends account details and navigates into the authenticated app', async () => {
  const { elements, modeButtons, destinations, requests } = loadFlow();
  assert.equal(elements['#loginEmail'].value, '');
  modeButtons[1].dispatch('click');
  assert.equal(elements['#loginForm'].hidden, true);
  assert.equal(elements['#registerForm'].hidden, false);
  assert.equal(modeButtons[1].attributes['aria-pressed'], 'true');
  assert.equal(elements['#registerName'].value, 'Usuario de prueba');
  assert.equal(elements['#registerCountryCode'].value, 'MX');
  assert.equal(elements['#registerCelular'].value, '0000000000');
  elements['#registerEmail'].value = 'user@example.com';
  assert.equal(elements['#registerAge'].value, '30');
  assert.equal(elements['#registerHeight'].value, '');
  assert.equal(elements['#registerSex'].value, 'masculino');

  elements['#registerPassword'].value = 'correct-horse-123';
  elements['#confirmPassword'].value = 'correct-horse-123';
  elements['#registerHeight'].value = '168.5';
  await elements['#registerForm'].dispatch('submit');
  assert.equal(destinations.pop(), '/');
  const registration = requests.find(([url]) => url === '/api/auth/register');
  assert.equal(requests.some(([url]) => url === '/api/auth/login'), false);
  assert.equal(JSON.parse(registration[1].body).heightCm, '168.5');
  assert.equal(JSON.parse(registration[1].body).email, 'user@example.com');

});

test('registration rejects mismatched passwords', () => {
  const { elements, destinations } = loadFlow();
  elements['#registerPassword'].value = 'password-one';
  elements['#confirmPassword'].value = 'password-two';
  elements['#registerForm'].dispatch('submit');
  assert.equal(destinations.length, 0);
  assert.equal(elements['#confirmPassword'].validationMessage, 'Las contraseñas no coinciden.');
  assert.equal(elements['#confirmPassword'].reportedValidity, true);
});

test('email verification returns to login with the verified email filled in', async () => {
  const { elements } = loadFlow('?verify=valid-token', async () => ({
    ok: true,
    json: async () => ({ ok: true, email: 'user@example.com' }),
  }));
  await settle();
  assert.equal(elements['#loginEmail'].value, 'user@example.com');
});

test('password recovery request uses the entered email and shows a generic confirmation', async () => {
  const { elements, requests } = loadFlow();
  elements['#loginEmail'].value = 'user@example.com';
  await elements['#forgotPasswordButton'].dispatch('click');
  const html = readFileSync(require.resolve('./login.html'), 'utf8');
  assert.match(html, /id="forgotPasswordButton"[^>]*>Recuperar contraseña<\/button>/);
  assert.doesNotMatch(html, /resendVerificationButton|Reenviar verificación de correo/);
  assert.equal(elements['#recoveryEmail'].value, 'user@example.com');
  await elements['#recoveryRequestForm'].dispatch('submit');
  assert.equal(requests.at(-1)[0], '/api/auth/request-password-reset');
  assert.equal(JSON.parse(requests.at(-1)[1].body).email, 'user@example.com');
  assert.equal(elements['#loginForm'].hidden, false);
});

test('Chef restores the submitted message after a failed request so it can be retried', async () => {
  const { elements } = loadFlow('', async () => { throw new Error('network unavailable'); });
  elements['#chefMessage'].value = 'Quiero una receta con frijoles';
  await elements['#chefForm'].dispatch('submit');
  assert.equal(elements['#chefMessage'].value, 'Quiero una receta con frijoles');
});

test('password reset link shows the new-password form and submits its token', async () => {
  let submitted;
  const { elements } = loadFlow('?reset=valid-token', async (...args) => {
    submitted = args;
    return { ok: true, json: async () => ({ ok: true, message: 'Contraseña actualizada.' }) };
  });
  assert.equal(elements['#resetPasswordForm'].hidden, false);
  elements['#newPassword'].value = 'new-safe-password-123';
  elements['#confirmNewPassword'].value = 'new-safe-password-123';
  await elements['#resetPasswordForm'].dispatch('submit');
  assert.equal(submitted[0], '/api/auth/reset-password');
  assert.deepEqual(JSON.parse(submitted[1].body), { token: 'valid-token', password: 'new-safe-password-123' });
  assert.equal(elements['#loginForm'].hidden, false);
});

test('registration requires identity fields and keeps country code separate from phone', () => {
  const html = readFileSync(require.resolve('./login.html'), 'utf8');
  const form = html.match(/<form id="registerForm"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form);
  for (const id of ['registerName', 'registerCountryCode', 'registerEmail', 'registerPassword', 'confirmPassword', 'registerAge', 'registerSex', 'registerHeight']) {
    assert.match(form, new RegExp(`<[^>]+id="${id}"[^>]*required`), `${id} must be required`);
  }
  assert.match(form, /<input id="registerHeight"[^>]*type="number"[^>]*min="80"[^>]*max="250"/);
  assert.match(form, /<select id="registerSex"[\s\S]*?value="masculino"[\s\S]*?value="femenino"/);
  assert.match(form, /<select id="registerCountryCode"[\s\S]*?value="MX" data-dial-code="\+52"/);
  assert.match(form, /<input id="registerEmail"[^>]*type="email"[^>]*required/);
  assert.match(form, /<input id="registerCelular"[^>]*type="tel"[^>]*>/);
  assert.doesNotMatch(form.match(/<input id="registerCelular"[^>]*>/)?.[0] || '', /required/);
  assert.match(html, /<input id="loginEmail"[^>]*type="email"[^>]*autocomplete="email"[^>]*required/);
});

test('calendar-day preferences no longer expose interval controls', () => {
  const form = readFileSync(require.resolve('./preferencias.html'), 'utf8');
  const dashboard = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  assert.doesNotMatch(form + dashboard, /nutritionDay(Start|End)|editNutrition(Start|End)|nutritionWindow|Ventana nutricional/);
});

test('personal preferences open with clearly marked fictitious defaults', () => {
  const { elements } = loadFlow();
  assert.equal(elements['#deviceModeManual'].checked, true);
  assert.equal(elements['#dietPattern'].value, 'sin_preferencia');
  assert.equal(elements['#allergiesStatus'].value, 'sin_informacion');
  assert.equal(elements['#medicationsStatus'].value, 'sin_informacion');
  assert.equal(elements['#testDataNotice'].hidden, false);
  assert.equal(elements['#allergiesDetails'].hidden, true);
  assert.equal(elements['#medicationsDetails'].hidden, true);
});

test('edit forms load saved values and cancel returns to More without logout', async () => {
  const { elements, destinations, requests } = loadFlow('?edit=1');
  await new Promise(setImmediate);
  assert.equal(elements['#preferencesTitle'].textContent, 'Actualizar preferencias personales');
  assert.equal(elements['#cancelPreferences'].textContent, 'Cancelar');
  assert.equal(elements['#dietPattern'].value, 'vegano');
  assert.equal(elements['#integrationUsername'].value, 'owner@example.com');
  assert.equal(elements['#integrationPassword'].value, '');
  await elements['#cancelPreferences'].dispatch('click');
  assert.equal(destinations.pop(), '/dashboard_nutricional.html?view=more');
  assert.equal(requests.some(([url]) => url === '/api/auth/logout'), false);
});

test('cancel on initial preferences revokes the session and returns to login', async () => {
  const { elements, destinations, requests } = loadFlow();
  await elements['#cancelPreferences'].dispatch('click');
  assert.equal(requests.at(-1)[0], '/api/auth/logout');
  assert.equal(requests.at(-1)[1].method, 'POST');
  assert.equal(destinations.pop(), '/login.html');
});

test('calendar date picker navigates arbitrary dates and keeps the selected day in the URL', () => {
  const { elements, destinations } = loadFlow();
  elements['#daySelect'].value = '2026-01-31';
  elements['#previousDayButton'].dispatch('click');
  assert.match(destinations.pop(), /date=2026-01-30/);
  elements['#daySelect'].value = '2026-03-01';
  elements['#nextDayButton'].dispatch('click');
  assert.match(destinations.pop(), /date=2026-03-02/);
  elements['#daySelect'].value = '2026-02-30';
  elements['#daySelect'].dispatch('change');
  assert.equal(destinations.length, 0);
});

test('dashboard has responsive calendar and More exposes editable forms and account actions', () => {
  const html = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  const css = readFileSync(require.resolve('./dashboard_nutricional.css'), 'utf8');
  const js = readFileSync(require.resolve('./onboarding-flow.js'), 'utf8');
  assert.match(html, /<input id="daySelect"[^>]*type="date"/);
  assert.doesNotMatch(html, /objetivos-iniciales|personalObjectivesPanel|objectivesEditDialog|moreObjectivesButton/);
  assert.ok(html.indexOf('id="todayView"') < html.indexOf('id="daySelect"'));
  assert.ok(html.indexOf('id="daySelect"') < html.indexOf('id="progressView"'));
  assert.doesNotMatch(html, /data-dashboard-tab="diary"/);
  assert.match(html, /id="morePreferencesButton"/);
  assert.match(html, /id="preferencesEditDialog" class="more-form-dialog"/);
  for (const id of ['moreNutritionWindowButton', 'moreIntegrationsButton', 'assistantLauncher']) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="logoutButton"/);
  assert.match(html, /id="deleteAccountButton"/);
  assert.match(css, /\.day-navigation input\[type="date"\][^{]*\{[^}]*min-width:\s*0/);
  assert.match(css, /grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.more-actions\s*\{\s*grid-template-columns:\s*1fr;/);
  assert.match(html, /id="accountHeightCm"/);
  for (const id of ['progressCorrelationMetrics', 'progressActivityMetrics', 'progressActivityChart', 'progressQualityMetrics']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="progressBiometricsCharts"/);
  assert.match(html, /id="progressRangeCaption"/);
  assert.match(js, /la línea conecta lecturas observadas/i);
  assert.doesNotMatch(html, /id="trendCharts"/);
  assert.match(css, /\.biometric-trend-grid/);
  assert.match(html, /no se guardan cargas\/volumen de fuerza/i);
});

test('More contains accessible biometric and plicometer forms with their measurement fields', () => {
  const html = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  const css = readFileSync(require.resolve('./dashboard_nutricional.css'), 'utf8');
  for (const id of ['biometricWeight', 'biometricBodyAge', 'biometricBodyFat', 'biometricBmr', 'biometricVisceral', 'biometricBmi', 'biometricMuscle', 'biometricsForm']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="biometricsForm"[\s\S]*?Guardar registro biométrico/);
  assert.match(html, /id="biometricsTableBody"/);
  for (const id of ['morePlicometroButton', 'plicometroDate', 'plicometroTriceps', 'plicometroBiceps', 'plicometroSubescapular', 'plicometroSuprailiaco', 'plicometroAbdominal', 'plicometroMuslo', 'plicometroPantorrilla', 'plicometroForm']) assert.match(html, new RegExp(`id="${id}"`));
  for (const id of ['biometricsModal', 'plicometroModal', 'preferencesEditDialog', 'deleteAccountDialog']) assert.match(html, new RegExp(`<dialog id="${id}" class="more-form-dialog`));
  assert.match(css, /\.more-form-dialog\[open\][^{]*\{[^}]*max-height/);
  assert.match(css, /\.more-form-header, \.modal-head/);
});

test('Register food opens a More-style description form with weighing guidance and save', () => {
  const html = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  assert.match(html, /id="registerFoodButton"/);
  assert.match(html, /<dialog id="registerFoodDialog" class="more-form-dialog"/);
  assert.match(html, /pesa los alimentos en báscula para obtener datos más precisos\./);
  assert.match(html, /id="foodEntryFeedback"[^>]*aria-live="polite"/);
  assert.match(html, /id="foodDescription"[\s\S]*required/);
  assert.doesNotMatch(html, /foodEntryTrace|foodEntryResult/);
  assert.match(html, /id="saveFoodButton"[^>]*>Guardar</);
  assert.doesNotMatch(html, /foodClarificationForm|foodClarificationQuestion|Enviar aclaración/);
});

test('opening Registrar comida restores the draft without preparing an unused OpenCode session', async () => {
  const { elements, requests } = loadFlow();
  await elements['#registerFoodButton'].dispatch('click');
  assert.equal(requests.some(([url]) => url === '/api/food/session'), false);
  assert.equal(elements['#foodDescription'].disabled, false);
  assert.equal(elements['#saveFoodButton'].disabled, false);
  assert.equal(elements['#registerFoodDialog'].open, true);
});

test('food modal can reopen during analysis without resubmitting the request', async () => {
  let finishRequest;
  const { elements, requests } = loadFlow('', (url) => url === '/api/food-entries'
    ? new Promise((resolve) => { finishRequest = resolve; })
    : Promise.resolve({ ok: true, json: async () => ({ ok: true }) }));
  await elements['#registerFoodButton'].dispatch('click');
  assert.equal(elements['#saveFoodButton'].disabled, false);
  elements['#foodDescription'].value = '150 g de pollo';
  const submission = elements['#registerFoodForm'].dispatch('submit');
  await new Promise(setImmediate);
  assert.equal(elements['#foodDescription'].value, '');
  assert.equal(elements['#saveFoodButton'].disabled, true);
  assert.equal(elements['#foodLoading'].hidden, false);
  assert.equal(elements['#foodButtonLoading'].hidden, false);
  assert.equal(elements['#registerFoodButton'].attributes['aria-busy'], 'true');
  assert.equal(elements['#registerFoodButton'].disabled, false);
  elements['#registerFoodDialog'].close();
  assert.equal(elements['#foodButtonLoading'].hidden, false);
  await elements['#registerFoodButton'].dispatch('click');
  assert.equal(elements['#registerFoodDialog'].open, true);
  assert.equal(elements['#saveFoodButton'].disabled, true);
  finishRequest({ ok: true, json: async () => ({ records: [], message: 'Descripción enviada.' }) });
  await submission;
  await settle();
  assert.equal(requests.some(([url]) => url.startsWith('/api/food-entries?fecha=')), false);
  assert.equal(elements['#foodEntryFeedback'].textContent, 'Descripción enviada.');
  assert.equal(elements['#saveFoodButton'].disabled, false);
  assert.equal(elements['#foodDescription'].disabled, false);
  assert.equal(elements['#foodLoading'].hidden, true);
  assert.equal(elements['#foodButtonLoading'].hidden, true);
  assert.equal(elements['#registerFoodButton'].attributes['aria-busy'], 'false');
  assert.equal(elements['#registerFoodButton'].disabled, false);
  assert.equal(elements['#foodEntryTrace'], undefined);
  assert.equal(elements['#foodEntryResult'], undefined);
});

test('food modal shows a safe OpenCode transport error without trace details', async () => {
  const { elements } = loadFlow('', async (url) => url === '/api/food-entries'
    ? { ok: false, json: async () => ({ message: 'El servicio no respondió.' }) }
    : { ok: true, json: async () => ({ ok: true }) });
  await elements['#registerFoodButton'].dispatch('click');
  elements['#foodDescription'].value = '150 g de pollo';
  await elements['#registerFoodForm'].dispatch('submit');
  await settle();
  assert.match(elements['#foodEntryFeedback'].textContent, /El servicio no respondió/);
  assert.equal(elements['#saveFoodButton'].disabled, false);
  assert.equal(elements['#foodLoading'].hidden, true);
});

test('temporary food errors retain the message and retry the identical payload', async () => {
  const posts = [];
  const { elements } = loadFlow('', async (url, options = {}) => {
    if (url !== '/api/food-entries') return { ok: true, json: async () => ({}) };
    posts.push(options.body);
    return posts.length === 1
      ? { ok: false, status: 503, json: async () => ({ error: 'Servicio temporalmente no disponible.' }) }
      : { ok: true, json: async () => ({ records: [], messages: [], state: 'completado', message: 'Guardado.' }) };
  });
  await elements['#registerFoodButton'].dispatch('click');
  elements['#foodDescription'].value = '150 g de pollo';
  await elements['#registerFoodForm'].dispatch('submit');
  await settle();
  const message = elements['#foodChatMessages'].children.find((node) => node.dataset.role === 'user');
  assert.ok(message);
  const retry = message.children.find((node) => node.className === 'button-muted food-chat-retry');
  assert.ok(retry);
  await retry.dispatch('click');
  await settle();
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
});

test('stale food responses cannot replace a more recent list or saved result', async () => {
  const pending = [];
  const flow = loadFlow('', async (url) => url.startsWith('/api/food-entries?')
    ? new Promise((resolve) => pending.push(resolve))
    : { ok: true, json: async () => ({}) });
  const list = new Element();
  flow.elements['#foodEntriesList'] = list;
  flow.evaluate('renderFoodEntries = (records) => { globalThis.renderedRecords = records; }');
  const first = flow.evaluate("loadFoodEntries('2026-11-09')");
  const second = flow.evaluate("loadFoodEntries('2026-11-10')");
  pending[1]({ ok: true, json: async () => ({ records: [{ id: 'new' }] }) });
  await second;
  pending[0]({ ok: true, json: async () => ({ records: [{ id: 'old' }] }) });
  await first;
  assert.equal(flow.evaluate('renderedRecords[0].id'), 'new');
  const third = flow.evaluate("loadFoodEntries('2026-11-10')");
  flow.evaluate("foodEntriesLoadId += 1; renderFoodEntries([{ id: 'saved' }]);");
  pending[2]({ ok: true, json: async () => ({ records: [{ id: 'before-save' }] }) });
  await third;
  assert.equal(flow.evaluate('renderedRecords[0].id'), 'saved');
});

test('stopping training progress does not wait for a hung request', async () => {
  let signal;
  const flow = loadFlow('', (url, options) => url.startsWith('/api/training-progress?')
    ? (signal = options.signal, new Promise(() => {}))
    : Promise.resolve({ ok: true, json: async () => ({}) }));
  const progress = flow.evaluate("startTrainingProgress('test', () => document.createElement('div'))");
  await progress.stop('Terminado.');
  assert.equal(signal.aborted, true);
});

test('training and plan progress backs off on unchanged stages, resets on change and stops on 401', async () => {
  const timers = [];
  const labels = ['Generando', 'Generando', 'Generando', 'Generando', 'Generando', 'Validando'];
  let requests = 0;
  const flow = loadFlow('', async (url) => {
    if (!url.startsWith('/api/training-progress?')) return { ok: true, json: async () => ({}) };
    const label = labels[requests++];
    return label ? { ok: true, status: 200, json: async () => ({ progress: { label } }) }
      : { ok: false, status: 401, json: async () => ({}) };
  }, { setTimeout: (callback, ms) => { timers.push({ callback, ms }); return 0; } });
  await settle();
  timers.length = 0;
  const progress = flow.evaluate("startTrainingProgress('adaptive', () => document.createElement('div'))");
  for (const delay of [1000, 2000, 4000, 5000, 5000, 1000]) {
    await settle();
    const timer = timers.shift();
    assert.equal(timer?.ms, delay);
    timer.callback();
  }
  await settle();
  assert.equal(requests, 7);
  assert.equal(timers.length, 0);
  await progress.stop('Terminado.');
});

test('temporary drafts survive a reload, expire, and are isolated by account', () => {
  const storage = new Map();
  const first = loadFlow('', undefined, { storage });
  first.evaluate("draftStorage('plan', { draftToken: 'signed', expiresAt: Date.now() + 60000 })");
  const restored = loadFlow('', undefined, { storage });
  assert.equal(restored.evaluate("draftStorage('plan').draftToken"), 'signed');
  const other = loadFlow('', undefined, { storage, scope: 'b'.repeat(64) });
  assert.equal(other.evaluate("draftStorage('plan')"), null);
  first.evaluate("draftStorage('plan', { draftToken: 'expired', expiresAt: Date.now() - 1 })");
  assert.equal(restored.evaluate("draftStorage('plan')"), null);
});

test('a pending training save survives reload and retries without another model analysis', async () => {
  const storage = new Map();
  const ids = ['trainingModal', 'addTrainingButton', 'trainingDescription', 'trainingAnalyzeButton', 'trainingLoading', 'trainingLoadingText', 'trainingFeedback', 'trainingChatMessages', 'syncGarminTrainingButton', 'trainingModeToggle', 'trainingDescriptionFields', 'trainingButtonLoading'];
  const posts = [];
  let analyses = 0;
  const fetch = async (url, options = {}) => {
    if (url === '/api/training-analysis') {
      analyses += 1;
      return { ok: true, json: async () => ({ analysis: {
        trainingSession: true, activity: 'Correr', durationMinutes: 30, weightKg: 70, met: 7,
        caloriesKcal: 257.3, saveTimeStatus: 'none', biometricContext: { latestWeightKg: 70 }, formula: 'MET × peso × duración',
      } }) };
    }
    if (url === '/api/training-entries') {
      posts.push(options.body);
      return posts.length === 1
        ? { ok: false, status: 503, json: async () => ({ error: 'No se pudo verificar el guardado.' }) }
        : { ok: true, status: 201, json: async () => ({ savedAt: '11:00' }) };
    }
    return { ok: true, json: async () => ({}) };
  };
  const first = loadFlow('', fetch, { ids, storage, intl: Intl });
  await settle();
  first.elements['#trainingChatMessages'].querySelectorAll = () => (first.elements['#trainingChatMessages'].children || [])
    .filter((node) => node.dataset.role === 'user').map((node) => node.children.find((child) => child.className === 'food-chat-text'));
  first.elements['#trainingDescription'].value = 'Corrí 30 minutos';
  first.elements['#daySelect'].value = '2026-11-10';
  first.evaluate('trainingSessionReady = true;');
  await first.elements['#trainingAnalyzeButton'].dispatch('click');
  assert.equal(first.elements['#trainingAnalyzeButton'].textContent, 'Reintentar guardado');
  assert.equal(JSON.parse(posts[0]).description, 'Corrí 30 minutos');
  assert.equal(JSON.parse(posts[0]).date, '2026-11-10');
  assert.match(JSON.parse(posts[0]).savedAt, /^\d{2}:\d{2}$/);
  const reloaded = loadFlow('', fetch, { ids, storage });
  reloaded.evaluate('trainingSessionReady = true;');
  await reloaded.elements['#trainingAnalyzeButton'].dispatch('click');
  assert.equal(analyses, 1);
  assert.equal(posts.length, 2);
  assert.equal(posts[0], posts[1]);
  assert.equal(reloaded.evaluate("draftStorage('training')"), null);
});

test('generating and saving a plan never replaces the active dashboard targets', async () => {
  const ids = ['trainingPlanGoals', 'sendTrainingPlanGoals', 'saveTrainingPlan', 'goToSavedTrainingPlans', 'trainingPlanDialog', 'createTrainingPlanButton', 'trainingPlanButtonLoading', 'planChatMessages', 'planLoading', 'planSummaryText', 'savedTrainingPlans'];
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const flow = loadFlow('', async (url) => ({ ok: true, json: async () =>
    url === '/api/training-plan' ? { plan: 'Borrador', macros, runId: 'draft', draftToken: 'signed', expiresAt: Date.now() + 60000 }
      : url === '/api/training-plans' ? { id: '41', createdAt: '2026-11-10T17:00:00Z', plans: [] } : {} }),
  { ids, intl: Intl, elements: { 'label[for="trainingPlanGoals"]': new Element() } });
  await settle();
  flow.evaluate('selectedActiveTrainingPlan = { macros: { calorias_kcal: 1800 } }; setTrainingPlanTargets(selectedActiveTrainingPlan.macros);');
  flow.elements['#trainingPlanGoals'].value = 'Ganar fuerza';
  await flow.elements['#sendTrainingPlanGoals'].dispatch('click');
  assert.equal(flow.evaluate('trainingPlanTargets.calorias_kcal'), 1800);
  assert.equal(flow.evaluate('generatedTrainingMacros.calorias_kcal'), 2000);
  await flow.elements['#saveTrainingPlan'].dispatch('click');
  assert.equal(flow.evaluate('savedTrainingPlan'), true);
  assert.equal(flow.evaluate('trainingPlanTargets.calorias_kcal'), 1800);
  assert.equal(flow.evaluate("draftStorage('plan')"), null);
});

test('reopening plans restores a signed backup before displaying it or requesting changes', async () => {
  const ids = ['trainingPlanGoals', 'sendTrainingPlanGoals', 'saveTrainingPlan', 'goToSavedTrainingPlans', 'trainingPlanDialog', 'createTrainingPlanButton', 'trainingPlanButtonLoading', 'planChatMessages', 'planLoading', 'planSummaryText'];
  const storage = new Map();
  const initial = loadFlow('', undefined, { storage });
  initial.evaluate("draftStorage('plan', { draftToken: 'signed-backup', expiresAt: Date.now() + 60000 })");
  const calls = [];
  const macros = { proteinas_g: 140, carbohidratos_g: 220, grasas_g: 65, calorias_kcal: 2000 };
  const restored = loadFlow('', async (url, options = {}) => {
    calls.push([url, options]);
    return { ok: true, json: async () => url === '/api/training-plan/restore'
      ? { plan: 'Borrador recuperado', goals: 'Ganar fuerza', macros, runId: 'draft' }
      : url === '/api/training-plan/refine'
        ? { plan: 'Borrador modificado', macros, runId: 'draft', draftToken: 'updated-backup', expiresAt: Date.now() + 60000 } : {} };
  }, { ids, storage, intl: Intl, elements: { 'label[for="trainingPlanGoals"]': new Element() } });
  await restored.elements['#createTrainingPlanButton'].dispatch('click');
  assert.equal(restored.elements['#trainingPlanDialog'].open, true);
  assert.equal(restored.evaluate('generatedTrainingPlan'), 'Borrador recuperado');
  assert.equal(restored.evaluate('generatedTrainingGoals'), 'Ganar fuerza');
  restored.elements['#trainingPlanGoals'].value = 'Tres días';
  await restored.elements['#sendTrainingPlanGoals'].dispatch('click');
  const refine = calls.find(([url]) => url === '/api/training-plan/refine');
  assert.equal(JSON.parse(refine[1].body).draftToken, 'signed-backup');
  assert.equal(calls.some(([url]) => url === '/api/training-plan'), false);
  assert.equal(restored.evaluate("draftStorage('plan').draftToken"), 'updated-backup');
});

test('clarification applies multiple preview edits together in the reply composer', async () => {
  const foodPosts = [];
  const { elements } = loadFlow('', async (url, options = {}) => {
    if (url === '/api/food-entries') {
      foodPosts.push(options);
      return { ok: true, json: async () => ({ state: 'requiere_aclaracion', requestId: '123e4567-e89b-42d3-a456-426614174000', question: '¿Cuántos gramos?', messages: [{ role: 'assistant', content: '¿Cuántos gramos?' }], previewItems: [
      { sourceText: 'Pollo', name: 'Pollo', quantityText: '100 g', quantityGrams: 100, macroStatus: 'estimado', macros: { energyKcal: 165, proteinG: 31, carbohydrateG: 0, fatG: 4 } },
      { sourceText: 'Arroz', name: 'Arroz', quantityText: '50 g', quantityGrams: 50, macroStatus: 'estimado', macros: { energyKcal: 65, proteinG: 1, carbohydrateG: 14, fatG: 0 } },
      ] }) };
    }
    return { ok: true, json: async () => ({ progress: null }) };
  });
  await elements['#registerFoodButton'].dispatch('click');
  elements['#foodDescription'].value = 'pollo';
  await elements['#registerFoodForm'].dispatch('submit');
  await settle();
  const preview = elements['#foodChatMessages'].children.find((child) => child.className === 'food-chat-preview');
  assert.ok(preview);
  const rows = preview.children.filter((child) => child.className === 'food-preview-row');
  rows[0].children[0].value = 'Pollo asado';
  rows[0].children[1].value = '150 g';
  await rows[0].children[3].dispatch('click');
  rows[1].children[1].value = '75 g';
  await rows[1].children[3].dispatch('click');
  assert.match(elements['#foodDescription'].value, /Pollo.*Pollo asado.*150 g/);
  assert.match(elements['#foodDescription'].value, /Arroz.*Arroz.*75 g/);
  assert.equal(elements['#foodDescription'].focused, true);
  await elements['#registerFoodForm'].dispatch('submit');
  await settle();
  const sentEdits = JSON.parse(foodPosts[1].body).previewEdits;
  assert.equal(sentEdits.length, 2);
  assert.equal(sentEdits[0].name, 'Pollo asado');
  assert.equal(sentEdits[1].quantityText, '75 g');
});

test('More tab switches the visible dashboard section', () => {
  const tabs = ['today', 'progress', 'more'].map((dashboardTab) => Object.assign(new Element(), { dataset: { dashboardTab } }));
  const views = ['today', 'progress', 'more'].map((dashboardView) => Object.assign(new Element(), { dataset: { dashboardView }, hidden: true }));
  const nodeList = (items) => ({ length: items.length, forEach: (callback) => items.forEach(callback), [Symbol.iterator]: function* () { yield* items; } });
  const document = {
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '[data-dashboard-tab]' ? nodeList(tabs) : selector === '[data-dashboard-view]' ? nodeList(views) : nodeList([]),
  };
  const window = { fetch: async () => ({ ok: true }), addEventListener() {}, location: { search: '', href: 'http://localhost/dashboard_nutricional.html', pathname: '/dashboard_nutricional.html', assign() {} } };
  vm.runInNewContext(readFileSync(require.resolve('./onboarding-flow.js'), 'utf8'), { document, window, fetch: async () => ({ ok: true }), Intl, URL, URLSearchParams, navigator: { wakeLock: null }, setTimeout: (callback, ms) => { if (ms <= 1500) setImmediate(callback); return 0; }, clearTimeout() {} });
  tabs[2].dispatch('click');
  assert.equal(views[2].hidden, false);
  assert.equal(views[0].hidden, true);
  assert.equal(tabs[2].attributes['aria-current'], 'page');
});

test('day-type controls are replaced by a time-ordered food list region', () => {
  const html = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  assert.match(html, /id="foodEntriesList"/);
  assert.match(html, /con su hora, alimentos y macros/i);
  for (const id of ['dayTypeSelect', 'applyDayTypeButton', 'dayTypeImpact']) assert.doesNotMatch(html, new RegExp(`id="${id}"`));
});

test('More preferences editor shares modal controls and saves changes', async () => {
  const { elements, requests } = loadFlow();
  await elements['#morePreferencesButton'].dispatch('click');
  assert.equal(elements['#preferencesEditDialog'].open, true);
  assert.equal(elements['#editDietPattern'].value, 'vegano');
  elements['#editDietPattern'].value = 'vegetariano';
  await elements['#preferencesEditForm'].dispatch('submit');
  assert.equal(elements['#preferencesEditDialog'].open, false);
  const save = requests.find(([url, options]) => url === '/api/onboarding/preferences' && options?.method === 'POST');
  assert.ok(save);
  assert.equal(JSON.parse(save[1].body).patronAlimentario, 'vegetariano');
});

test('More preferences repeats the onboarding field guidance', () => {
  const dashboard = readFileSync(require.resolve('./dashboard_nutricional.html'), 'utf8');
  const onboarding = readFileSync(require.resolve('./preferencias.html'), 'utf8');
  for (const message of [
    'Este campo es para gustos, no para alergias o restricciones médicas; esas requieren un registro separado.',
    'Se guardan como datos personales de salud para dar contexto; no modifican tratamientos ni sustituyen indicaciones médicas.',
  ]) {
    assert.ok(dashboard.includes(message) && onboarding.includes(message));
  }
});

test('More account and edit forms expose a working X close control', async () => {
  const { elements, requests } = loadFlow();
  elements['#deleteAccountButton'].dispatch('click');
  assert.equal(elements['#deleteAccountDialog'].open, true);
  assert.equal(elements['#deleteAccountPassword'].value, 'Demo-Prueba-2026!');
  elements['#closeDeleteAccount'].dispatch('click');
  assert.equal(elements['#deleteAccountDialog'].open, false);

  await elements['#morePreferencesButton'].dispatch('click');
  elements['#closePreferencesEdit'].dispatch('click');
  assert.equal(elements['#preferencesEditDialog'].open, false);

  assert.equal(requests.some(([url]) => url === '/api/auth/logout'), false);
});
