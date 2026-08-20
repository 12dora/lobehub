import { describe, expect, it } from 'vitest';

import { normalizeTabUrl, parseAgentTabContext } from './url';

describe('normalizeTabUrl', () => {
  it('keeps a plain pathname', () => {
    expect(normalizeTabUrl('/agent/abc')).toBe('/agent/abc');
  });

  it('strips a trailing slash', () => {
    expect(normalizeTabUrl('/agent/abc/')).toBe('/agent/abc');
  });

  it('keeps the root path intact', () => {
    expect(normalizeTabUrl('/')).toBe('/');
  });

  it('normalizes search param ordering', () => {
    expect(normalizeTabUrl('/agent/abc?b=2&a=1')).toBe('/agent/abc?a=1&b=2');
  });

  it('keeps all search params (identity-significant)', () => {
    expect(normalizeTabUrl('/group/g1?topic=t1')).toBe('/group/g1?topic=t1');
  });

  it('drops the hash fragment', () => {
    expect(normalizeTabUrl('/agent/abc?a=1#section')).toBe('/agent/abc?a=1');
  });

  it('makes equivalent URLs collapse to the same id', () => {
    expect(normalizeTabUrl('/agent/abc?a=1&b=2')).toBe(normalizeTabUrl('/agent/abc?b=2&a=1'));
  });
});

describe('parseAgentTabContext', () => {
  it('parses a bare agent url', () => {
    expect(parseAgentTabContext('/agent/abc')).toEqual({ agentId: 'abc', topicId: null });
  });

  it('parses an agent topic path url', () => {
    expect(parseAgentTabContext('/agent/abc/tpc_xyz')).toEqual({
      agentId: 'abc',
      topicId: 'tpc_xyz',
    });
  });

  it('parses topic from the search param', () => {
    expect(parseAgentTabContext('/agent/abc?topic=t1')).toEqual({
      agentId: 'abc',
      topicId: 't1',
    });
  });

  it('parses a workspace agent url', () => {
    expect(parseAgentTabContext('/acme/agent/abc')).toEqual({
      agentId: 'abc',
      topicId: null,
      workspaceSlug: 'acme',
    });
  });

  it('parses a workspace agent topic path url', () => {
    expect(parseAgentTabContext('/acme/agent/abc/tpc_xyz')).toEqual({
      agentId: 'abc',
      topicId: 'tpc_xyz',
      workspaceSlug: 'acme',
    });
  });

  it('parses workspace topic from the search param', () => {
    expect(parseAgentTabContext('/acme/agent/abc?topic=t1')).toEqual({
      agentId: 'abc',
      topicId: 't1',
      workspaceSlug: 'acme',
    });
  });

  it('returns null for non-agent urls', () => {
    expect(parseAgentTabContext('/group/g1')).toBeNull();
  });

  describe('home-context conversation urls', () => {
    it('parses a personal home conversation', () => {
      expect(parseAgentTabContext('/?agent=abc&topic=tpc_xyz')).toEqual({
        agentId: 'abc',
        topicId: 'tpc_xyz',
      });
    });

    it('parses a personal home conversation without a topic', () => {
      expect(parseAgentTabContext('/?agent=abc')).toEqual({ agentId: 'abc', topicId: null });
    });

    it('parses a workspace home conversation', () => {
      expect(parseAgentTabContext('/acme?agent=abc&topic=tpc_xyz')).toEqual({
        agentId: 'abc',
        topicId: 'tpc_xyz',
        workspaceSlug: 'acme',
      });
    });

    it('parses a workspace home conversation with a trailing slash', () => {
      expect(parseAgentTabContext('/acme/?agent=abc&topic=tpc_xyz')).toEqual({
        agentId: 'abc',
        topicId: 'tpc_xyz',
        workspaceSlug: 'acme',
      });
    });

    it('resolves to the same context as the canonical agent url', () => {
      expect(parseAgentTabContext('/?agent=abc&topic=tpc_xyz')).toEqual(
        parseAgentTabContext('/agent/abc/tpc_xyz'),
      );
      expect(parseAgentTabContext('/acme?agent=abc&topic=tpc_xyz')).toEqual(
        parseAgentTabContext('/acme/agent/abc/tpc_xyz'),
      );
    });

    it('ignores the hash fragment', () => {
      expect(parseAgentTabContext('/?agent=abc&topic=tpc_xyz#msg_1')).toEqual({
        agentId: 'abc',
        topicId: 'tpc_xyz',
      });
    });

    it('keeps the home landing page unparsed', () => {
      expect(parseAgentTabContext('/')).toBeNull();
      expect(parseAgentTabContext('/acme')).toBeNull();
    });

    it('leaves group home conversations null, same as canonical group urls', () => {
      expect(parseAgentTabContext('/?group=g1&topic=tpc_xyz')).toBeNull();
      expect(parseAgentTabContext('/acme?group=g1&topic=tpc_xyz')).toBeNull();
    });

    it('does not mistake another top-level route for a workspace home', () => {
      expect(parseAgentTabContext('/image')).toBeNull();
      expect(parseAgentTabContext('/settings/profile')).toBeNull();
    });
  });
});
