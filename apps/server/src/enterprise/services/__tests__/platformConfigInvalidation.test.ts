// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';

import {
  InMemoryPlatformConfigInvalidationPublisher,
  platformConfigKeys,
  setPlatformConfigInvalidationPublisher,
} from '../platformConfigInvalidation';

describe('platformConfigInvalidation', () => {
  beforeEach(() => {
    setPlatformConfigInvalidationPublisher(null);
  });

  it('records versions in the in-memory publisher', async () => {
    const pub = new InMemoryPlatformConfigInvalidationPublisher();
    await pub.publish({
      at: new Date().toISOString(),
      resourceId: 'singleton',
      resourceType: 'branding',
      revision: 3,
      scopes: ['branding'],
    });

    expect(pub.versions.get('branding:singleton')).toBe(3);
    expect(pub.versions.get('global')).toBe(3);
    expect(pub.versions.get('scope:branding')).toBe(3);

    await pub.publish({
      at: new Date().toISOString(),
      resourceId: 'other',
      resourceType: 'branding',
      revision: 1,
      scopes: ['branding'],
    });
    expect(pub.versions.get('global')).toBe(4);
    expect(pub.versions.get('scope:branding')).toBe(4);
    await expect(pub.getScopeVersion('branding')).resolves.toBe('4');
  });

  it('builds stable redis key names', () => {
    expect(platformConfigKeys.globalVersion()).toBe('platform:config:version');
    expect(platformConfigKeys.resourceVersion('settings', 'general.language')).toBe(
      'platform:config:version:settings:general.language',
    );
    expect(platformConfigKeys.scopeVersion('branding')).toBe(
      'platform:config:scope:branding:version',
    );
  });
});
