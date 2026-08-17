// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { parseCursorModelList } from './models';

describe('parseCursorModelList', () => {
  it('parses id/name lines and strips (current)/(default) suffixes', () => {
    const models = parseCursorModelList(`Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
cursor-grok-4.6-high - Cursor Grok 4.6 High (current)
not a model line
`);

    expect(models).toEqual([
      { id: 'auto', name: 'Auto' },
      { id: 'composer-2.5', name: 'Composer 2.5' },
      { id: 'cursor-grok-4.6-high', name: 'Cursor Grok 4.6 High' },
    ]);
  });
});
