// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { isValidElement } from 'react';
import { describe, expect, it } from 'vitest';

import AuthIcons from './AuthIcons';

/**
 * Provider ids reach this map straight from admin-managed database rows, so the lookup must not
 * resolve inherited object keys. Before the `Map`, `AuthIcons('__proto__')` handed React
 * `Object.prototype` and crashed the whole sign-in page.
 */
describe('AuthIcons', () => {
  it('renders a real icon for a known provider id', () => {
    const element = AuthIcons('dingtalk', 18);
    expect(isValidElement(element)).toBe(true);
    expect(() => render(element)).not.toThrow();
  });

  it('falls back to the generic glyph for prototype keys and unknown ids', () => {
    for (const id of [
      '__proto__',
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'prototype',
      'unknown-provider',
      '',
    ]) {
      const element = AuthIcons(id, 18);
      expect(isValidElement(element), `expected a React element for ${JSON.stringify(id)}`).toBe(
        true,
      );
      expect(() => render(element)).not.toThrow();
    }
  });
});
