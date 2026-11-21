import { expect, it, vi } from 'vitest';
import { holdCompanionPresence, isCompanionPresent, subscribeCompanionPresence } from './presence';

it('holds only the selected character and releases once after the last owner leaves', () => {
  const changed = vi.fn(), unsubscribe = subscribeCompanionPresence(changed);
  const first = holdCompanionPresence('one'), second = holdCompanionPresence('one');
  try {
    expect(isCompanionPresent('one')).toBe(true); expect(isCompanionPresent('two')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(1);
    first(); first(); expect(isCompanionPresent('one')).toBe(true);
    second(); expect(isCompanionPresent('one')).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
  } finally { first(); second(); unsubscribe(); }
});
