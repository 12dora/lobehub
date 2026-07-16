'use client';

import { useRef } from 'react';
import { mutate } from 'swr';

import { adminSkillsService } from '@/enterprise/client/services/adminSkills';
import { useClientDataSWR } from '@/libs/swr';

import {
  ADMIN_SKILL_DEPENDENTS_KEY,
  ADMIN_SKILL_GET_KEY,
  ADMIN_SKILL_LIST_KEY,
  ADMIN_SKILL_VERSION_KEY,
  ADMIN_SKILL_VERSIONS_KEY,
  buildAdminSkillDependentsKey,
  buildAdminSkillGetKey,
  buildAdminSkillListKey,
  buildAdminSkillVersionKey,
  buildAdminSkillVersionsKey,
} from '../swrKeys';
import type {
  AdminSkillGetDependentsInput,
  AdminSkillListInput,
  AdminSkillListVersionsInput,
} from '../types';

const useKeepCursorPreviousData = (identity: string, cursor: string | undefined) => {
  const key = `${identity}\u0000${cursor ?? ''}`;
  const transitionRef = useRef({ cursor, identity, keepPreviousData: false, key });
  if (transitionRef.current.key !== key) {
    transitionRef.current = {
      cursor,
      identity,
      keepPreviousData:
        transitionRef.current.identity === identity && transitionRef.current.cursor !== cursor,
      key,
    };
  }
  return transitionRef.current.keepPreviousData;
};

export const useFetchAdminSkills = (input: AdminSkillListInput, enabled = true) => {
  const identity = JSON.stringify([
    input.query ?? '',
    input.status ?? '',
    input.source ?? '',
    input.distribution ?? '',
    input.enabled ?? '',
    input.limit,
  ]);
  const keepPreviousData = useKeepCursorPreviousData(identity, input.cursor);
  return useClientDataSWR(
    enabled ? buildAdminSkillListKey(input) : null,
    () => adminSkillsService.list(input),
    { keepPreviousData, revalidateOnFocus: false },
  );
};

export const useFetchAdminSkill = (id: string | undefined, enabled = true) =>
  useClientDataSWR(
    enabled && id ? buildAdminSkillGetKey(id) : null,
    () => adminSkillsService.get({ id: id! }),
    { revalidateOnFocus: false },
  );

export const useFetchAdminSkillVersion = (
  skillId: string | undefined,
  versionId: string | undefined,
  enabled = true,
) =>
  useClientDataSWR(
    enabled && skillId && versionId ? buildAdminSkillVersionKey(skillId, versionId) : null,
    () => adminSkillsService.getVersion({ skillId: skillId!, versionId: versionId! }),
    { revalidateOnFocus: false },
  );

export const useFetchAdminSkillVersions = (
  input: AdminSkillListVersionsInput | undefined,
  enabled = true,
) => {
  const identity = input ? JSON.stringify([input.skillId, input.limit]) : 'disabled';
  const keepPreviousData = useKeepCursorPreviousData(identity, input?.cursor);
  return useClientDataSWR(
    enabled && input ? buildAdminSkillVersionsKey(input) : null,
    () => adminSkillsService.listVersions(input!),
    { keepPreviousData, revalidateOnFocus: false },
  );
};

export const useFetchAdminSkillDependents = (
  input: AdminSkillGetDependentsInput | undefined,
  enabled = true,
) => {
  const identity = input
    ? JSON.stringify([input.skillId, input.versionId ?? '', input.limit])
    : 'disabled';
  const keepPreviousData = useKeepCursorPreviousData(identity, input?.cursor);
  return useClientDataSWR(
    enabled && input ? buildAdminSkillDependentsKey(input) : null,
    () => adminSkillsService.getDependents(input!),
    { keepPreviousData, revalidateOnFocus: false },
  );
};

export const refreshAdminSkillLists = async () => {
  await mutate((key) => Array.isArray(key) && key[0] === ADMIN_SKILL_LIST_KEY);
};

export const refreshAdminSkill = async (id: string) => {
  const [detail] = await Promise.all([
    mutate(buildAdminSkillGetKey(id)),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_SKILL_LIST_KEY),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_SKILL_VERSIONS_KEY),
    mutate((key) => Array.isArray(key) && key[0] === ADMIN_SKILL_DEPENDENTS_KEY),
  ]);
  return detail;
};

export const clearAdminSkillCache = async () => {
  await mutate(
    (key) =>
      Array.isArray(key) &&
      [
        ADMIN_SKILL_GET_KEY,
        ADMIN_SKILL_LIST_KEY,
        ADMIN_SKILL_VERSION_KEY,
        ADMIN_SKILL_VERSIONS_KEY,
        ADMIN_SKILL_DEPENDENTS_KEY,
      ].includes(key[0]),
    undefined,
    { revalidate: false },
  );
};
