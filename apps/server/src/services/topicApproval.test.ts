import type { LobeChatDatabase } from '@lobechat/database';
import { describe, expect, it } from 'vitest';

import { applyTopicApprovalSnapshot } from './topicApproval';

const dummyDb = {} as LobeChatDatabase;

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
