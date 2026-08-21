import type { LobeChatDatabase } from '@lobechat/database';
import { describe, expect, it } from 'vitest';

import { applyTopicApprovalSnapshot, sanitizeWorkspaceTopicMetadata } from './topicApproval';

const dummyDb = {} as LobeChatDatabase;

describe('sanitizeWorkspaceTopicMetadata', () => {
  it('strips approvalMode for workspace topics and keeps sibling keys', () => {
    const metadata = sanitizeWorkspaceTopicMetadata(
      { approvalMode: 'auto-run', workingDirectory: '/tmp' },
      'ws-1',
    );

    expect(metadata).toEqual({ workingDirectory: '/tmp' });
    expect(metadata).not.toHaveProperty('approvalMode');
  });

  it('returns undefined when a workspace patch only had approvalMode', () => {
    expect(sanitizeWorkspaceTopicMetadata({ approvalMode: 'auto-run' }, 'ws-1')).toBeUndefined();
  });

  it('passes personal-topic metadata through, including approvalMode', () => {
    const metadata = { approvalMode: 'auto-run' as const, workingDirectory: '/tmp' };

    expect(sanitizeWorkspaceTopicMetadata(metadata)).toEqual(metadata);
    expect(sanitizeWorkspaceTopicMetadata(metadata, null)).toEqual(metadata);
  });
});

describe('applyTopicApprovalSnapshot', () => {
  it('strips client approvalMode for workspace topics and keeps sibling keys', async () => {
    const metadata = await applyTopicApprovalSnapshot({
      db: dummyDb,
      metadata: { approvalMode: 'auto-run', workingDirectory: '/tmp' },
      userId: 'u1',
      workspaceId: 'ws-1',
    });

    expect(metadata).toEqual({ workingDirectory: '/tmp' });
    expect(metadata).not.toHaveProperty('approvalMode');
  });

  it('returns undefined when a workspace topic only had approvalMode', async () => {
    const metadata = await applyTopicApprovalSnapshot({
      db: dummyDb,
      metadata: { approvalMode: 'auto-run' },
      userId: 'u1',
      workspaceId: 'ws-1',
    });

    expect(metadata).toBeUndefined();
  });
});
