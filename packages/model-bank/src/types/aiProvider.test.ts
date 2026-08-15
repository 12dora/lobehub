import { describe, expect, it } from 'vitest';

import { CreateAiProviderSchema, UpdateAiProviderSchema } from './aiProvider';

/**
 * `settings.oauthDeviceFlow` is parsed on the way in, so a knob missing from the schema is
 * silently STRIPPED — the field survives in the TypeScript interface and on the builtin
 * card while every stored provider quietly loses it. `refreshSkewMs` is the proactive
 * refresh window (ChatGPT Web widens it to 24 h because OpenAI drops an unused refresh
 * token), and losing it drops the connection back to the 2-minute default.
 */
describe('OAuthDeviceFlowConfigSchema', () => {
  const oauthDeviceFlow = {
    clientId: 'app_test',
    deviceCodeEndpoint: 'https://auth.example.com/device/code',
    refreshSkewMs: 24 * 60 * 60 * 1000,
    refreshTokenGrant: true,
    scopes: ['openid', 'offline_access'],
    tokenEndpoint: 'https://auth.example.com/token',
  };

  const createPayload = {
    id: 'chatgptweb',
    name: 'ChatGPT Web',
    settings: { authType: 'oauthDeviceFlow' as const, oauthDeviceFlow },
    source: 'custom' as const,
  };

  it('keeps refreshSkewMs through create parsing', () => {
    const parsed = CreateAiProviderSchema.parse(createPayload);

    expect(parsed.settings?.oauthDeviceFlow).toEqual(oauthDeviceFlow);
  });

  it('keeps refreshSkewMs through update parsing', () => {
    const parsed = UpdateAiProviderSchema.parse({
      name: 'ChatGPT Web',
      settings: { authType: 'oauthDeviceFlow' as const, oauthDeviceFlow },
    });

    expect(parsed.settings?.oauthDeviceFlow?.refreshSkewMs).toBe(24 * 60 * 60 * 1000);
  });

  it('accepts an omitted skew (the runtime default applies)', () => {
    const { refreshSkewMs: _omitted, ...withoutSkew } = oauthDeviceFlow;
    const parsed = CreateAiProviderSchema.parse({
      ...createPayload,
      settings: { oauthDeviceFlow: withoutSkew },
    });

    expect(parsed.settings?.oauthDeviceFlow).not.toHaveProperty('refreshSkewMs');
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('rejects a %s skew, which would poison every expiry comparison', (_label, refreshSkewMs) => {
    expect(() =>
      CreateAiProviderSchema.parse({
        ...createPayload,
        settings: { oauthDeviceFlow: { ...oauthDeviceFlow, refreshSkewMs } },
      }),
    ).toThrow();
  });
});
