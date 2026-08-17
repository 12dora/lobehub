import { describe, expect, it } from 'vitest';

import {
  AGENT_ARCHIVE_AUTO_REASON,
  AUTO_REASON,
  AUTO_REASON_LEGACY,
  CONNECTOR_ROLLBACK_AUTO_REASON,
  CREATE_USER_AUTO_REASON,
  formatAuditReason,
  MODERATION_AUTO_BAN_REASON_CODE,
  SHARED_OAUTH_AUTO_REASON,
  TOOL_SCOPE_AUTO_REASON,
} from './auditReasonCodes';

const t = (key: string, options?: { count?: number }) =>
  options?.count === undefined ? `zh:${key}` : `zh:${key}#${options.count}`;

describe('formatAuditReason (production mapping)', () => {
  it('maps stable reason codes to i18n keys', () => {
    expect(formatAuditReason(AUTO_REASON.delete, t)).toBe('zh:audit.autoReason.delete');
    expect(formatAuditReason(CREATE_USER_AUTO_REASON, t)).toBe('zh:audit.autoReason.create');
    expect(formatAuditReason(SHARED_OAUTH_AUTO_REASON, t)).toBe('zh:audit.autoReason.sharedOAuth');
    expect(formatAuditReason(AUTO_REASON.roles, t)).toBe('zh:audit.autoReason.roles');
  });

  it('maps the connector / assistant / tool-scope codes written outside the users module', () => {
    expect(formatAuditReason(CONNECTOR_ROLLBACK_AUTO_REASON, t)).toBe(
      'zh:audit.autoReason.connectorRollback',
    );
    expect(formatAuditReason(AGENT_ARCHIVE_AUTO_REASON, t)).toBe(
      'zh:audit.autoReason.agentArchive',
    );
    for (const [name, code] of Object.entries(TOOL_SCOPE_AUTO_REASON)) {
      expect(formatAuditReason(code, t)).toBe(`zh:audit.autoReason.toolScope.${name}`);
    }
  });

  it('still localizes legacy prose reasons from older clients', () => {
    expect(formatAuditReason(AUTO_REASON_LEGACY.delete, t)).toBe('zh:audit.autoReason.delete');
    expect(formatAuditReason(AUTO_REASON_LEGACY.sharedOAuth, t)).toBe(
      'zh:audit.autoReason.sharedOAuth',
    );
    expect(formatAuditReason(AUTO_REASON_LEGACY.connectorRollback, t)).toBe(
      'zh:audit.autoReason.connectorRollback',
    );
    expect(formatAuditReason(AUTO_REASON_LEGACY.agentArchive, t)).toBe(
      'zh:audit.autoReason.agentArchive',
    );
    expect(formatAuditReason(AUTO_REASON_LEGACY.toolScopeSkillImport, t)).toBe(
      'zh:audit.autoReason.toolScope.skillImport',
    );
  });

  it('carries the violation count of the moderation auto-ban reason', () => {
    expect(formatAuditReason(`${MODERATION_AUTO_BAN_REASON_CODE}:3`, t)).toBe(
      'zh:audit.autoReason.moderationAutoBan#3',
    );
    // Prose written by moderation builds before the machine code.
    expect(formatAuditReason('内容审计：窗口内违规 5 次', t)).toBe(
      'zh:audit.autoReason.moderationAutoBan#5',
    );
  });

  it('leaves free-form admin reasons verbatim', () => {
    expect(formatAuditReason('policy violation: spam', t)).toBe('policy violation: spam');
    expect(formatAuditReason(`${MODERATION_AUTO_BAN_REASON_CODE}:not-a-number`, t)).toBe(
      `${MODERATION_AUTO_BAN_REASON_CODE}:not-a-number`,
    );
  });

  it('does not resolve inherited object members as reason codes', () => {
    expect(formatAuditReason('constructor', t)).toBe('constructor');
    expect(formatAuditReason('toString', t)).toBe('toString');
  });

  it('returns null for empty reasons', () => {
    expect(formatAuditReason(null, t)).toBeNull();
    expect(formatAuditReason(undefined, t)).toBeNull();
    expect(formatAuditReason('', t)).toBeNull();
  });
});
