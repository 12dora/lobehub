import { describe, expect, it } from 'vitest';

import {
  EMPTY_PLATFORM_REVISION_BUNDLE,
  PLATFORM_RESOURCE_TYPES,
  type PlatformConfigRevision,
} from './revision';

describe('platform_config_revision contract', () => {
  it('lists resource types without requiring a database table', () => {
    expect(PLATFORM_RESOURCE_TYPES).toContain('settings');
    expect(PLATFORM_RESOURCE_TYPES).toContain('branding');
    expect(PLATFORM_RESOURCE_TYPES).toContain('identity');
  });

  it('accepts a typed revision row shape', () => {
    const row: PlatformConfigRevision = {
      checksum: 'abc',
      resourceId: 'global',
      resourceType: 'settings',
      revision: 1,
      updatedAt: '2026-07-16T00:00:00.000Z',
    };
    expect(row.revision).toBe(1);
  });

  it('empty revision bundle uses zero config revision', () => {
    expect(EMPTY_PLATFORM_REVISION_BUNDLE.configRevision).toBe('0');
    expect(EMPTY_PLATFORM_REVISION_BUNDLE.settingsRevision).toBeNull();
  });
});
