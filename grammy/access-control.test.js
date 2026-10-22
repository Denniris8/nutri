import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedChat, parseAllowedChatIds } from './access-control.js';

describe('Telegram chat access control', () => {
  it('parses only safe integer chat IDs from the allowlist', () => {
    assert.deepEqual([...parseAllowedChatIds(' 123, -456,invalid,9007199254740992,,')], [123, -456]);
    assert.equal(parseAllowedChatIds('').size, 0);
  });

  it('allows only an exact integer ID present in the configured set', () => {
    const allowed = parseAllowedChatIds('123,-456');
    assert.equal(isAllowedChat(123, allowed), true);
    assert.equal(isAllowedChat(-456, allowed), true);
    assert.equal(isAllowedChat(124, allowed), false);
    assert.equal(isAllowedChat('123', allowed), false);
  });
});
