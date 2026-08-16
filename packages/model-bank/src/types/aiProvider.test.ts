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

  /**
   * `webSessionOnly` hides the authorization-code UI and makes the pasted web session the ONE
   * connect route. That only holds together on a card that already connects by paste and
   * already accepts a pasted credential — otherwise the flag either hides nothing (device
   * code is a different branch) or renders the only offered form into a server-side
   * rejection. The contract has to refuse those, not trust the card author.
   */
  describe('webSessionOnly', () => {
    const sessionOnly = {
      ...oauthDeviceFlow,
      allowAccessTokenPaste: true,
      grantFlow: 'authorization_code_paste' as const,
      webSessionOnly: true,
    };

    it('accepts the paste-flow card that ChatGPT Web ships', () => {
      const parsed = CreateAiProviderSchema.parse({
        ...createPayload,
        settings: { oauthDeviceFlow: sessionOnly },
      });

      expect(parsed.settings?.oauthDeviceFlow).toEqual(sessionOnly);
    });

    it.each([
      [
        'a device-code card, where the flag hides nothing',
        { ...sessionOnly, grantFlow: 'device_code' as const },
      ],
      [
        'a card whose pasted-credential gate is closed',
        { ...sessionOnly, allowAccessTokenPaste: false },
      ],
    ])('rejects %s', (_label, oauth) => {
      expect(() =>
        CreateAiProviderSchema.parse({ ...createPayload, settings: { oauthDeviceFlow: oauth } }),
      ).toThrow();

      expect(() =>
        UpdateAiProviderSchema.parse({
          name: 'ChatGPT Web',
          settings: { oauthDeviceFlow: oauth },
        }),
      ).toThrow();
    });

    it('leaves a card that never sets the flag alone', () => {
      const parsed = CreateAiProviderSchema.parse(createPayload);

      expect(parsed.settings?.oauthDeviceFlow).not.toHaveProperty('webSessionOnly');
    });
  });
});
