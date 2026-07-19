import { describe, expect, it } from 'vitest';

import { getResetPasswordEmailTemplate } from './reset-password';

describe('branded email templates', () => {
  it('uses the supplied runtime name and HTML-escapes it', () => {
    const template = getResetPasswordEmailTemplate({
      platformName: 'AI & Hub',
      url: 'https://example.com/reset',
    });

    expect(template.subject).toBe('Reset Your Password - AI & Hub');
    expect(template.html).toContain('AI &amp; Hub');
    expect(template.html).not.toContain('AI & Hub');
  });
});
