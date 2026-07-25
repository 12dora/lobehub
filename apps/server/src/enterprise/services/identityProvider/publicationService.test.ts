/**
 * Publication service tests are split by concern (SVC-ID-008):
 * - publicationService.publish.test.ts
 * - publicationService.idempotency.test.ts
 * - publicationService.disable.test.ts
 * Shared fixtures: publicationService.test.harness.ts
 *
 * This stub keeps the historical path from 404'ing in docs/scripts; real suites live above.
 */
import { describe, expect, it } from 'vitest';

describe('IdentityProviderPublicationService (split index)', () => {
  it('suites live in publish / idempotency / disable test files', () => {
    expect(true).toBe(true);
  });
});
