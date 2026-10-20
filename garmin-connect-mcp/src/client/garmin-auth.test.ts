import { describe, expect, it } from 'vitest';
import { getGarminTokenDirectory } from './garmin-auth';

describe('Garmin account token directories', () => {
  it('keeps each account token cache isolated without exposing the email in its path', () => {
    const first = getGarminTokenDirectory('First.Person@example.com', '/home/test');
    const normalizedFirst = getGarminTokenDirectory(' first.person@EXAMPLE.com ', '/home/test');
    const second = getGarminTokenDirectory('second@example.com', '/home/test');

    expect(first).toBe(normalizedFirst);
    expect(first).not.toBe(second);
    expect(first).not.toContain('First.Person@example.com');
  });
});
