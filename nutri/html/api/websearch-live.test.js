const assert = require('node:assert/strict');
const test = require('node:test');
const { deleteFoodOpenCodeSession, ensureFoodOpenCodeSession, openCodeRequest, requestOpenCode } = require('./opencode-food.js');

test('returns search candidates for a websearch-only OpenCode prompt', { skip: process.env.NUTRI_TEST_WEBSEARCH_LIVE !== '1' }, async () => {
  const userId = '987654321';
  const textSql = (value) => `CONVERT(0x${Buffer.from(value, 'utf8').toString('hex')} USING utf8mb4)`;
  let storedSession = '';
  const dbQuery = async (sql) => {
    if (sql.includes('SELECT session_id FROM sesiones_comidas_opencode')) return storedSession;
    const inserted = sql.match(/INSERT INTO sesiones_comidas_opencode[^]*?VALUES \(\d+,CONVERT\(0x([a-f\d]+) USING utf8mb4\)\)/i);
    if (inserted) { storedSession = Buffer.from(inserted[1], 'hex').toString('utf8'); return ''; }
    if (sql.includes('DELETE FROM sesiones_comidas_opencode')) { storedSession = ''; return ''; }
    throw new Error('unexpected_test_query');
  };
  let sessionId;
  try {
    sessionId = await ensureFoodOpenCodeSession({ userId, dbQuery, textSql, requestOpenCode });
    const result = await openCodeRequest('POST', `/session/${sessionId}/message`, {
      system: 'Use only websearch. Do not use webfetch. Return the actual search-result titles, URLs, and snippets; do not invent missing data.',
      tools: { websearch: true },
      parts: [{ type: 'text', text: 'Search for cooked white rice nutrition facts per 100 g.' }],
    }, 120000);
    const answer = result.data.parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n').trim();
    const urls = [...answer.matchAll(/https:\/\/[^\s)]+/g)].map(([url]) => url.replace(/[.,]+$/, ''));
    assert.ok(answer && urls.length, 'OpenCode returned no search-result text or HTTPS URLs');
    console.log(`WEBSEARCH_RESULT=${JSON.stringify({ answer, urls })}`);
  } finally {
    if (sessionId) await deleteFoodOpenCodeSession({ userId, dbQuery, requestOpenCode });
  }
});
