import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('managed Connector SkillList', () => {
  it('keeps connected LobeHub and Composio rows selectable in managed mode', () => {
    const source = readFileSync('src/routes/(main)/settings/skill/features/SkillList.tsx', 'utf8');

    expect(source).toContain("onSelect(item.provider.id, 'lobehub-connector')");
    expect(source).toContain("onSelect(item.serverType.identifier, 'plugin')");
    expect(source).not.toContain('!managed && onSelect');
  });
});
