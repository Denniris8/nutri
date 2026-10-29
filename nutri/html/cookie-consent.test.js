const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const script = readFileSync(require.resolve('./cookie-consent.js'), 'utf8');

function loadConsent(saved = null) {
  const notice = { hidden: true };
  const listeners = {};
  const acknowledge = { addEventListener: (name, callback) => { listeners[name] = callback; } };
  const writes = [];
  vm.runInNewContext(script, {
    document: { querySelector: (selector) => selector === '#cookieConsentNotice' ? notice : acknowledge },
    localStorage: { getItem: () => saved, setItem: (...args) => writes.push(args) },
  });
  return { notice, listeners, writes };
}

test('cookie notice stays hidden after acknowledgement was saved', () => {
  assert.equal(loadConsent('1').notice.hidden, true);
});

test('cookie notice is dismissible and remembers acknowledgement', () => {
  const { notice, listeners, writes } = loadConsent();
  assert.equal(notice.hidden, false);
  listeners.click();
  assert.equal(notice.hidden, true);
  assert.deepEqual(writes, [['nutriCookieNoticeV1', '1']]);
});

test('cookie notice is present on every app page', () => {
  for (const page of ['login.html', 'dashboard_nutricional.html', 'preferencias.html', 'terminos.html']) {
    const html = readFileSync(require.resolve(`./${page}`), 'utf8');
    assert.match(html, /id="cookieConsentNotice"/);
    assert.match(html, /cookie-consent\.css/);
    assert.match(html, /cookie-consent\.js/);
  }
});
