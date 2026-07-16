// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminSkillGetDependentsInput,
  AdminSkillListInput,
  AdminSkillListVersionsInput,
} from '../types';
import {
  useFetchAdminSkillDependents,
  useFetchAdminSkills,
  useFetchAdminSkillVersions,
} from './useAdminSkills';

const mocks = vi.hoisted(() => ({ configs: [] as { keepPreviousData?: boolean }[] }));

vi.mock('swr', () => ({ mutate: vi.fn() }));

vi.mock('@/libs/swr', () => ({
  useClientDataSWR: (_key: unknown, _fetcher: unknown, config: { keepPreviousData?: boolean }) => {
    mocks.configs.push(config);
    return { data: undefined, error: undefined, isLoading: true, mutate: vi.fn() };
  },
}));

vi.mock('@/enterprise/client/services/adminSkills', () => ({
  adminSkillsService: {
    getDependents: vi.fn(),
    list: vi.fn(),
    listVersions: vi.fn(),
  },
}));

const lastKeep = () => mocks.configs.at(-1)?.keepPreviousData;

describe('M08 admin Skill cursor previous-data scope', () => {
  beforeEach(() => {
    mocks.configs.length = 0;
  });

  it('keeps list data only for cursor transitions within the exact filter fingerprint', () => {
    const base: AdminSkillListInput = { limit: 50 };
    const { rerender } = renderHook(({ input }) => useFetchAdminSkills(input), {
      initialProps: { input: base },
    });
    expect(lastKeep()).toBe(false);

    rerender({ input: { ...base, cursor: 'cursor-2' } });
    expect(lastKeep()).toBe(true);
    rerender({ input: { ...base, cursor: 'cursor-2' } });
    expect(lastKeep()).toBe(true);

    for (const input of [
      { ...base, query: 'docs' },
      { ...base, status: 'published' as const },
      { ...base, source: 'uploaded' as const },
      { ...base, distribution: 'mandatory' as const },
      { ...base, enabled: true },
      { ...base, limit: 20 },
    ]) {
      rerender({ input });
      expect(lastKeep()).toBe(false);
    }
  });

  it('keeps version pages only while Skill identity and limit are unchanged', () => {
    const base: AdminSkillListVersionsInput = { limit: 20, skillId: 'skill-1' };
    const { rerender } = renderHook(({ input }) => useFetchAdminSkillVersions(input), {
      initialProps: { input: base },
    });
    expect(lastKeep()).toBe(false);
    rerender({ input: { ...base, cursor: 'cursor-2' } });
    expect(lastKeep()).toBe(true);
    rerender({ input: { ...base, skillId: 'skill-2' } });
    expect(lastKeep()).toBe(false);
  });

  it('does not retain dependent rows across Skill or version identity changes', () => {
    const base: AdminSkillGetDependentsInput = {
      limit: 20,
      skillId: 'skill-1',
      versionId: 'version-1',
    };
    const { rerender } = renderHook(({ input }) => useFetchAdminSkillDependents(input), {
      initialProps: { input: base },
    });
    expect(lastKeep()).toBe(false);
    rerender({ input: { ...base, cursor: 'cursor-2' } });
    expect(lastKeep()).toBe(true);
    rerender({ input: { ...base, versionId: 'version-2' } });
    expect(lastKeep()).toBe(false);
  });
});
