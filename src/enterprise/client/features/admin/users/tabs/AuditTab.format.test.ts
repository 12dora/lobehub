import { describe, expect, it } from 'vitest';

import { SHARED_OAUTH_AUTO_REASON } from '../../managedResources/auditReasonCodes';
import {
  AUTO_REASON,
  AUTO_REASON_LEGACY,
  CREATE_USER_AUTO_REASON,
  formatAuditReason,
} from '../auditReasonCodes';

describe('formatAuditReason (production mapping)', () => {
  it('maps stable reason codes to i18n keys', () => {
    const t = (key: string) => `zh:${key}`;
    expect(formatAuditReason(AUTO_REASON.delete, t)).toBe('zh:users.audit.autoReason.delete');
    expect(formatAuditReason(CREATE_USER_AUTO_REASON, t)).toBe('zh:users.audit.autoReason.create');
    expect(formatAuditReason(SHARED_OAUTH_AUTO_REASON, t)).toBe(
      'zh:users.audit.autoReason.sharedOAuth',
    );
    expect(formatAuditReason(AUTO_REASON.roles, t)).toBe('zh:users.audit.autoReason.roles');
  });

  it('still localizes legacy English prose reasons from older clients', () => {
    const t = (key: string) => `zh:${key}`;
    expect(formatAuditReason(AUTO_REASON_LEGACY.delete, t)).toBe(
      'zh:users.audit.autoReason.delete',
    );
    expect(formatAuditReason(AUTO_REASON_LEGACY.sharedOAuth, t)).toBe(
      'zh:users.audit.autoReason.sharedOAuth',
    );
  });

  it('leaves free-form admin reasons verbatim', () => {
    const t = (key: string) => `zh:${key}`;
    expect(formatAuditReason('policy violation: spam', t)).toBe('policy violation: spam');
  });

  it('returns null for empty reasons', () => {
    const t = (key: string) => key;
    expect(formatAuditReason(null, t)).toBeNull();
    expect(formatAuditReason(undefined, t)).toBeNull();
    expect(formatAuditReason('', t)).toBeNull();
  });
});
