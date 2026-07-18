import { describe, expect, it } from 'vitest';

import {
  decodePlatformAgentListId,
  encodePlatformAgentListId,
  PLATFORM_AGENT_LIST_ID_PREFIX,
} from './agents';

describe('platform Agent list identity codec', () => {
  it('round-trips a platform Agent id through encode/decode', () => {
    const encoded = encodePlatformAgentListId('pagt_abc123');
    expect(encoded).toBe(`${PLATFORM_AGENT_LIST_ID_PREFIX}pagt_abc123`);
    expect(decodePlatformAgentListId(encoded)).toBe('pagt_abc123');
  });

  it('does not collide with ordinary local Agent ids / slugs', () => {
    // Local Agent ids are `agt_…`; slugs are word-word-word — neither carries the prefix.
    expect(decodePlatformAgentListId('agt_localnano123')).toBeNull();
    expect(decodePlatformAgentListId('inbox')).toBeNull();
    expect(decodePlatformAgentListId('happy-blue-otter')).toBeNull();
  });

  it('returns null for a bare or empty encoded id (no forgeable empty target)', () => {
    expect(decodePlatformAgentListId(PLATFORM_AGENT_LIST_ID_PREFIX)).toBeNull();
    expect(decodePlatformAgentListId('')).toBeNull();
  });
});
