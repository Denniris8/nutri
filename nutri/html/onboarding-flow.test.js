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
  setCustomValidity(message) { this.validationMessage = message; }
  reportValidity() { this.reportedValidity = true; }
  matches() { return false; }
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

function loadFlow(search = '', fetchOverride) {
  const ids = [
    'loginForm', 'loginCountryCode', 'loginCelular', 'loginPassword', 'registerForm', 'errorMessage', 'cancelRegister',
    'registerName', 'registerCountryCode', 'registerCelular', 'registerPassword', 'registerHeight',
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
  ];
  const elements = Object.fromEntries(ids.map((id) => [`#${id}`, new Element()]));
  elements['#loginCountryCode'].selectedOptions = [{ dataset: { dialCode: '+52' } }];
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
    if (request[0].startsWith('/api/onboarding/preferences') && !request[1]?.method) return { ok: true, json: async () => ({ preferences: {
      deviceMode: search.includes('edit=1') ? 'garmin' : 'ninguno', garminConnected: search.includes('edit=1'), garminEmail: search.includes('edit=1') ? 'owner@example.com' : null,
      patronAlimentario: 'vegano', allergiesStatus: 'sin_informacion', medicationsStatus: 'sin_informacion',
    } }) };
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const fetch = fetchOverride || defaultFetch;
  const document = {
    addEventListener() {},
    querySelector: (selector) => elements[selector] || null,
    querySelectorAll: (selector) => selector === '[data-mode]' ? modeButtons : [],
    createElement: () => new Element(),
  };
  const window = { fetch, addEventListener() {}, location: { href: `http://localhost/dashboard_nutricional.html${search}`, search, pathname: '/dashboard_nutricional.html', assign: (url) => destinations.push(url) } };
  const source = readFileSync(require.resolve('./onboarding-flow.js'), 'utf8');
  const Intl = { DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: 'America/Mexico_City' }) }) };
  vm.runInNewContext(source, { document, window, fetch, Intl, URL, URLSearchParams, navigator: { wakeLock: null }, setTimeout: () => 0, clearTimeout() {}, crypto: { randomUUID: () => '123e4567-e89b-42d3-a456-426614174000', getRandomValues: (bytes) => bytes.fill(1) } });
  return { elements, modeButtons, destinations, requests };
}

test('registration sends measured height and preferences proceeds directly to terms', async () => {
  const { elements, modeButtons, destinations, requests } = loadFlow();
  assert.equal(elements['#loginCelular'].value, '0000000000');
  assert.equal(elements['#loginPassword'].value, 'Demo-Prueba-2026!');
  modeButtons[1].dispatch('click');
  assert.equal(elements['#loginForm'].hidden, true);
  assert.equal(elements['#registerForm'].hidden, false);
  assert.equal(modeButtons[1].attributes['aria-pressed'], 'true');
  assert.equal(elements['#registerName'].value, 'Usuario de prueba');
  assert.equal(elements['#registerCountryCode'].value, 'MX');
  assert.equal(elements['#registerCelular'].value, '0000000000');
  assert.equal(elements['#registerAge'].value, '30');
  assert.equal(elements['#registerHeight'].value, '');
  assert.equal(elements['#registerSex'].value, 'masculino');

  elements['#registerPassword'].value = 'correct-horse-123';
  elements['#confirmPassword'].value = 'correct-horse-123';
  elements['#registerHeight'].value = '168.5';
  await elements['#registerForm'].dispatch('submit');
  assert.equal(destinations.pop(), '/');
  const registration = requests.find(([url]) => url === '/api/auth/register');
  assert.equal(JSON.parse(registration[1].body).heightCm, '168.5');

  elements['#dietPattern'].value = 'vegetariano';
  await elements['#preferencesForm'].dispatch('submit');
  assert.equal(destinations.pop(), '/terminos.html');
  const [preferencesUrl, preferencesRequest] = requests.at(-1);
  assert.equal(preferencesUrl, '/api/onboarding/preferences');
  assert.equal(preferencesRequest.headers['X-Client-Timezone'], 'America/Mexico_City');
  assert.equal(JSON.parse(preferencesRequest.body).patronAlimentario, 'vegetariano');
  assert.equal(Object.hasOwn(JSON.parse(preferencesRequest.body), 'nutritionWindow'), false);

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

test('registration requires identity fields and keeps country code separate from phone', () => {
  const html = readFileSync(require.resolve('./login.html'), 'utf8');
  const form = html.match(/<form id="registerForm"[^>]*>([\s\S]*?)<\/form>/)?.[1];
  assert.ok(form);
  for (const id of ['registerName', 'registerCountryCode', 'registerCelular', 'registerPassword', 'confirmPassword', 'registerAge', 'registerSex', 'registerHeight']) {
    assert.match(form, new RegExp(`<[^>]+id="${id}"[^>]*required`), `${id} must be required`);
  }
  assert.match(form, /<input id="registerHeight"[^>]*type="number"[^>]*min="80"[^>]*max="250"/);
  assert.match(form, /<select id="registerSex"[\s\S]*?value="masculino"[\s\S]*?value="femenino"/);
  assert.match(form, /<select id="registerCountryCode"[\s\S]*?value="MX" data-dial-code="\+52"/);
  assert.match(form, /<input id="registerCelular"[^>]*type="tel"/);
  assert.match(html, /<select id="loginCountryCode"[\s\S]*?value="MX" data-dial-code="\+52"/);
  assert.match(html, /<input id="loginCelular"[^>]*autocomplete="tel-national"/);
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
  assert.match(elements['#foodEntryFeedback'].textContent, /El servicio no respondió/);
  assert.equal(elements['#saveFoodButton'].disabled, false);
  assert.equal(elements['#foodLoading'].hidden, true);
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
  vm.runInNewContext(readFileSync(require.resolve('./onboarding-flow.js'), 'utf8'), { document, window, fetch: async () => ({ ok: true }), Intl, URL, URLSearchParams, navigator: { wakeLock: null }, setTimeout: () => 0, clearTimeout() {} });
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
