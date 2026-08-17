import { describe, expect, it } from 'vitest';

import { isInformationalSubscriptionIssue, networkProxySubscriptionIssueKey } from './errors';

describe('networkProxySubscriptionIssueKey', () => {
  it('maps known codes and falls back to unknown', () => {
    expect(networkProxySubscriptionIssueKey('timeout')).toBe(
      'networkProxy.subscriptionIssue.timeout',
    );
    expect(networkProxySubscriptionIssueKey('http_status')).toBe(
      'networkProxy.subscriptionIssue.http_status',
    );
    expect(networkProxySubscriptionIssueKey('TimeoutError')).toBe(
      'networkProxy.subscriptionIssue.unknown',
    );
    expect(networkProxySubscriptionIssueKey(null)).toBe('networkProxy.subscriptionIssue.unknown');
  });

  it('treats outlet fallback as informational, not an error', () => {
    expect(isInformationalSubscriptionIssue('outlet_unavailable_fetched_direct')).toBe(true);
    expect(isInformationalSubscriptionIssue('timeout')).toBe(false);
    expect(isInformationalSubscriptionIssue(undefined)).toBe(false);
  });
});
