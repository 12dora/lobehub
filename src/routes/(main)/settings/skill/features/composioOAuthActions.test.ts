import { describe, expect, it, vi } from 'vitest';

import {
  createPersonalComposioConnection,
  reauthorizePersonalComposioConnection,
} from './composioOAuthActions';

describe('personal Composio OAuth UI contract', () => {
  it('connects using only catalog identity fields', async () => {
    const createConnection = vi.fn().mockResolvedValue(undefined);
    await createPersonalComposioConnection({
      createConnection,
      serverType: {
        appSlug: 'gmail',
        author: 'Composio',
        description: 'Gmail',
        icon: 'gmail.svg',
        identifier: 'gmail',
        label: 'Gmail',
        readme: 'Gmail connector',
      },
    });

    expect(createConnection).toHaveBeenCalledWith({
      appSlug: 'gmail',
      identifier: 'gmail',
      label: 'Gmail',
    });
    expect(Object.keys(createConnection.mock.calls[0][0]).sort()).toEqual([
      'appSlug',
      'identifier',
      'label',
    ]);
  });

  it('reauthorizes using only the local catalog identifier', async () => {
    const reauthorizeConnection = vi.fn().mockResolvedValue(undefined);
    await reauthorizePersonalComposioConnection({
      identifier: 'gmail',
      reauthorizeConnection,
    });

    expect(reauthorizeConnection).toHaveBeenCalledWith('gmail');
  });
});
