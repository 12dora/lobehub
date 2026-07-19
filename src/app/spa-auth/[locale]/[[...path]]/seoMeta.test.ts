import { describe, expect, it } from 'vitest';

import { BUILT_IN_RUNTIME_BRANDING } from '@/enterprise/client/providers/runtimeBranding';

import { buildAuthSeoEntry, buildSeoMeta } from './seoMeta';

describe('buildAuthSeoEntry', () => {
  const branding = { ...BUILT_IN_RUNTIME_BRANDING, name: 'AI & Hub', publishedRevision: '42' };

  it('maps /signin to signin metadata', async () => {
    const entry = await buildAuthSeoEntry('en-US', '/signin', branding);

    expect(entry.canonicalPath).toBe('/signin');
    expect(entry.title).toBe('Sign In');
    expect(entry.description).toContain('account');
    expect(entry.description).toContain('AI & Hub');
  });

  it('maps /signup to signup metadata', async () => {
    const entry = await buildAuthSeoEntry('en-US', '/signup');

    expect(entry.canonicalPath).toBe('/signup');
    expect(entry.title).toBe('Create Account');
    expect(entry.description).toBe('Start your Agents collaboration space');
  });

  it('uses hand-translated zh-CN keys', async () => {
    const signin = await buildAuthSeoEntry('zh-CN', '/signin');
    const signup = await buildAuthSeoEntry('zh-CN', '/signup');

    expect(signin.title).toBe('登录');
    expect(signup.title).toBe('创建账号');
    expect(signup.description).toBe('开启 Agents 协作空间');
  });

  it('strips a trailing slash before matching', async () => {
    const entry = await buildAuthSeoEntry('en-US', '/signin/');

    expect(entry.canonicalPath).toBe('/signin');
    expect(entry.title).toBe('Sign In');
  });

  it('falls back to branding for unmapped paths', async () => {
    const entry = await buildAuthSeoEntry('en-US', '/oauth/consent');

    expect(entry.canonicalPath).toBeUndefined();
    expect(entry.title).toBeTruthy();
    expect(entry.description).toBeTruthy();
  });
});

describe('buildSeoMeta', () => {
  const branding = {
    ...BUILT_IN_RUNTIME_BRANDING,
    name: 'AI & Hub',
    ogImageUrl: 'https://assets.example.com/og.png',
    publishedRevision: '42',
  };

  it('uses one runtime branding snapshot and escapes it in HTML', async () => {
    const meta = await buildSeoMeta('en-US', '/signin', branding);

    expect(meta).toContain('AI &amp; Hub');
    expect(meta).toContain('https://assets.example.com/og.png');
    expect(meta).not.toContain('AI & Hub');
  });

  it('emits the Published favicon with its revision while preserving its query', async () => {
    const meta = await buildSeoMeta('en-US', '/signin', {
      ...branding,
      faviconUrl: '/favicon.webp?tenant=one',
    });

    expect(meta).toContain(
      '<link rel="icon" href="/favicon.webp?tenant=one&amp;runtime_branding_revision=42" />',
    );
  });

  it('joins canonical path onto official url for mapped paths', async () => {
    const meta = await buildSeoMeta('en-US', '/signin');

    expect(meta).toContain('<title>Sign In</title>');
    expect(meta).toContain('property="og:url" content="https://app.lobehub.com/signin"');
  });

  it('normalizes hostile locale input to an allowlisted value', async () => {
    const hostile = '"><script>alert(1)</script>';
    const meta = await buildSeoMeta(hostile, '/signin');

    expect(meta).not.toContain(hostile);
    expect(meta).not.toContain('alert(1)');
    expect(meta).toContain('property="og:locale" content="en-US"');
  });

  it('uses official url for unmapped paths', async () => {
    const meta = await buildSeoMeta('en-US', '/verify-email');

    expect(meta).toContain('property="og:url" content="https://app.lobehub.com"');
    expect(meta).toContain('property="og:locale" content="en-US"');
  });
});
