// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  checkExtraPublishedHolders,
  checkFixedHolderPresence,
  checkFixedHolderPublishedShape,
  checkHolderChecksumFormat,
  checkHolderResourceType,
  checkPointerDigestDrift,
  checkResourceRevisionResolvedCount,
  checkRevisionHistoryStatuses,
  checkRevisionPointerInteger,
  checkTargetRevisionStatus,
  checkVersionOwner,
  checkVersionPointerResolvedCount,
} from './invariants.pointers.checks';
import type {
  FixedHolderRevisionPointerSource,
  PointerCheckResult,
} from './invariants.pointers.result';
import {
  collectPointerChecks,
  RESOURCE_REVISION_PUBLISHED_STATUS,
} from './invariants.pointers.result';

/**
 * Narrow to the failing arm before reading its message. A check that was supposed to report a
 * finding and instead passed is itself a failure of this suite — say so, rather than reading
 * `detail` off a union where only one arm carries it.
 */
const detailOf = (result: PointerCheckResult): string => {
  if (result.match) throw new Error('expected a failing pointer check, got a pass');
  return result.detail;
};

const brandingSource = {
  holderIdColumn: 'id',
  holderIdValue: 'branding:published',
  holderStatusColumn: 'status',
  holderStatusValue: 'published',
  kind: 'fixed-holder-revision',
  pointerColumn: 'revision',
  resourceOwnerConstant: 'global',
  resourceType: 'branding',
  table: 'platform_branding',
} as FixedHolderRevisionPointerSource;

describe('publication pointer named checks', () => {
  it('emits the original non-integer revision finding', () => {
    const result = checkRevisionPointerInteger('platform_connectors', 'c1', '1.5');
    expect(result).toEqual({
      detail: 'non-integer-revision-pointer:platform_connectors:c1:1.5',
      match: false,
      records: [],
    });
    expect(checkRevisionPointerInteger('platform_connectors', 'c1', '12').match).toBe(true);
  });

  it('emits holder resource-type mismatch only when the holder column disagrees', () => {
    expect(
      detailOf(checkHolderResourceType('platform_connectors', 'c1', true, 'skill', 'connector')),
    ).toBe('holder-resource-type-mismatch:platform_connectors:c1:skill');
    expect(
      checkHolderResourceType('platform_connectors', 'c1', true, 'connector', 'connector').match,
    ).toBe(true);
    expect(
      checkHolderResourceType('platform_connectors', 'c1', true, null, 'connector').match,
    ).toBe(true);
    expect(
      checkHolderResourceType('platform_connectors', 'c1', false, 'skill', 'connector').match,
    ).toBe(true);
  });

  it('rejects missing, empty, or non-lowercase-sha256 holder checksums', () => {
    const table = 'platform_connectors';
    expect(detailOf(checkHolderChecksumFormat(table, 'c1', 'published_checksum', null))).toBe(
      'missing-or-invalid-holder-checksum:platform_connectors:c1',
    );
    expect(detailOf(checkHolderChecksumFormat(table, 'c1', 'published_checksum', ''))).toBe(
      'missing-or-invalid-holder-checksum:platform_connectors:c1',
    );
    expect(
      detailOf(checkHolderChecksumFormat(table, 'c1', 'published_checksum', 'A'.repeat(64))),
    ).toBe('missing-or-invalid-holder-checksum:platform_connectors:c1');
    expect(
      checkHolderChecksumFormat(table, 'c1', 'published_checksum', 'ab'.repeat(32)).match,
    ).toBe(true);
    expect(checkHolderChecksumFormat(table, 'c1', null, null).match).toBe(true);
  });

  it('emits dangling then ambiguous resource-revision findings', () => {
    expect(
      detailOf(
        checkResourceRevisionResolvedCount(
          'platform_connectors',
          'c1',
          '3',
          'connector',
          'owner-1',
          0,
        ),
      ),
    ).toBe('dangling-pointer:platform_connectors:c1:3:connector:owner=owner-1');
    expect(
      detailOf(
        checkResourceRevisionResolvedCount(
          'platform_connectors',
          'c1',
          '3',
          'connector',
          'owner-1',
          2,
        ),
      ),
    ).toBe('ambiguous-pointer:platform_connectors:c1:3');
  });

  it('requires the published revision status token', () => {
    expect(RESOURCE_REVISION_PUBLISHED_STATUS).toBe('published');
    expect(detailOf(checkTargetRevisionStatus('platform_connectors', 'c1', '3', 'draft'))).toBe(
      'target-revision-status-mismatch:platform_connectors:c1:3:status=draft:expected=published',
    );
    expect(checkTargetRevisionStatus('platform_connectors', 'c1', '3', 'published').match).toBe(
      true,
    );
  });

  it('joins extra published holder ids in inventory order', () => {
    expect(detailOf(checkExtraPublishedHolders('platform_branding', ['a', 'b']))).toBe(
      'extra-published-holder:platform_branding:a,b',
    );
  });

  it('treats zero holders without history as pre-publish and skips remaining source checks', () => {
    const result = checkFixedHolderPresence(brandingSource, 0, false, 0);
    expect(result.match).toBe(true);
    if (!result.match) return;
    expect(result.skipSource).toBe(true);
    expect(result.records).toEqual([
      {
        holder_id: 'branding:published',
        kind: 'fixed-holder-revision',
        publication: 'none',
        resource_owner_id: 'global',
        resource_type: 'branding',
        state: 'pre-publish',
        table: 'platform_branding',
      },
    ]);
  });

  it('fails closed when the fixed holder is missing but revision history exists', () => {
    expect(detailOf(checkFixedHolderPresence(brandingSource, 0, true, 4))).toBe(
      'missing-fixed-holder-with-revision-history:platform_branding:branding:published:branding/global:history=4',
    );
    expect(detailOf(checkFixedHolderPresence(brandingSource, 2, false, 0))).toBe(
      'ambiguous-fixed-holder-id:platform_branding:branding:published',
    );
  });

  it('rejects non-positive or non-integer fixed holder revisions', () => {
    expect(
      detailOf(
        checkFixedHolderPublishedShape(
          'platform_branding',
          { holder_id: 'branding:published', pointer: '0', status: 'published' },
          'published',
        ),
      ),
    ).toBe('invalid-fixed-holder-revision:platform_branding:branding:published:0');
    expect(
      detailOf(
        checkFixedHolderPublishedShape(
          'platform_branding',
          { holder_id: 'branding:published', pointer: '2', status: 'draft' },
          'published',
        ),
      ),
    ).toBe('fixed-holder-status-mismatch:platform_branding:branding:published:draft');
  });

  it('rejects empty revision-history status and version owner mismatch', () => {
    expect(
      detailOf(
        checkRevisionHistoryStatuses('platform_branding', 'branding', 'global', [
          { revision: '1', status: '' },
        ]),
      ),
    ).toBe('revision-history-status-invalid:platform_branding:branding/global:rev=1');
    expect(detailOf(checkVersionPointerResolvedCount('platform_skills', 's1', 'v1', 0))).toBe(
      'dangling-version-pointer:platform_skills:s1:v1',
    );
    expect(detailOf(checkVersionOwner('platform_skills', 's1', 'v1', 'other'))).toBe(
      'version-owner-mismatch:platform_skills:s1:v1:owner=other',
    );
  });

  it('treats a falsy prior pointer digest as no drift', () => {
    expect(checkPointerDigestDrift('abc', undefined).match).toBe(true);
    expect(checkPointerDigestDrift('abc', '').match).toBe(true);
    expect(detailOf(checkPointerDigestDrift('abc', 'def'))).toBe('pointer-digest-drift');
  });
});

describe('collectPointerChecks', () => {
  it('stops on the first finding and keeps records collected earlier in the list', async () => {
    const result = await collectPointerChecks([
      () => ({ match: true, records: [{ kind: 'kept' }] }),
      () => ({ detail: 'pointer-digest-drift', match: false, records: [{ kind: 'from-fail' }] }),
      () => ({ match: true, records: [{ kind: 'must-not-run' }] }),
    ]);
    expect(result).toEqual({
      detail: 'pointer-digest-drift',
      match: false,
      records: [{ kind: 'kept' }, { kind: 'from-fail' }],
    });
  });

  it('skips remaining checks when a pass sets skipSource', async () => {
    const result = await collectPointerChecks([
      () => ({ match: true, records: [{ kind: 'absent-column' }], skipSource: true as const }),
      () => {
        throw new Error('kind scanner must not run after absent-column');
      },
    ]);
    expect(result).toEqual({
      match: true,
      records: [{ kind: 'absent-column' }],
      skipSource: true,
    });
  });
});
