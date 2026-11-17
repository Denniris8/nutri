const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

test('offline asset cache never substitutes a different content version', async () => {
  const listeners = {};
  const stored = new Map();
  let online = true;
  const origin = 'https://nutri.example';
  const context = vm.createContext({
    self: { location: { origin }, addEventListener: (name, handler) => { listeners[name] = handler; } },
    URL, Request, Response,
    caches: { open: async () => ({
      put: async (key, value) => stored.set(key.url, value),
      match: async (key) => stored.get(key.url),
    }) },
    fetch: async (request) => {
      if (!online) throw new Error('offline');
      return new Response(new URL(request.url).searchParams.get('v'));
    },
  });
  vm.runInContext(readFileSync(require.resolve('./service-worker.js'), 'utf8'), context);
  const get = (version) => {
    let result;
    listeners.fetch({ request: new Request(`${origin}/onboarding-flow.js?v=${version}`),
      respondWith: (promise) => { result = promise; } });
    return result;
  };
  await get('first');
  await get('second');
  online = false;
  assert.equal(await (await get('first')).text(), 'first');
  assert.equal(await (await get('second')).text(), 'second');
  assert.equal((await get('missing')).type, 'error');
});
