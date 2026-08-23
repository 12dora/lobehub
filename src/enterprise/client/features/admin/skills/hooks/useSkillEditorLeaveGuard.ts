'use client';

import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import type { BlockerFunction } from 'react-router';

import { useUnsavedChangesGuard } from '../../primitives/useUnsavedChangesGuard';
import type { SkillEditorRefs } from './useSkillEditorState';

interface SkillEditorLeaveGuardInput {
  dirty: boolean;
  editable: boolean;
  refs: SkillEditorRefs;
  t: TFunction<'admin'>;
}

/**
 * Blocks navigation away from an unsaved draft, and remembers which Skill the operator was
 * heading for so the hydration effect can let that one — and only that one — through.
 */
export const useSkillEditorLeaveGuard = ({
  dirty,
  editable,
  refs,
  t,
}: SkillEditorLeaveGuardInput) => {
  const { allowedHydrationSkillIdRef, pendingNavigationSkillIdRef } = refs;

  const skillLeaveBlocker = useMemo<boolean | BlockerFunction>(() => {
    if (!editable || !dirty) return false;
    return ({ currentLocation, nextLocation }) => {
      if (currentLocation.pathname === nextLocation.pathname) return false;
      const match = /^\/admin\/skills\/([^/]+)$/.exec(nextLocation.pathname);
      try {
        pendingNavigationSkillIdRef.current = match ? decodeURIComponent(match[1]) : null;
      } catch {
        pendingNavigationSkillIdRef.current = null;
      }
      return true;
    };
  }, [dirty, editable, pendingNavigationSkillIdRef]);

  const unsavedMessages = useMemo(
    () => ({
      cancelText: t('skillCatalog.editor.unsaved.stay'),
      content: t('skillCatalog.editor.unsaved.desc'),
      okText: t('skillCatalog.editor.unsaved.leave'),
      title: t('skillCatalog.editor.unsaved.title'),
    }),
    [t],
  );

  useUnsavedChangesGuard({
    enabled: editable && dirty,
    messages: unsavedMessages,
    shouldBlock: skillLeaveBlocker,
    onProceed: () => {
      allowedHydrationSkillIdRef.current = pendingNavigationSkillIdRef.current;
      pendingNavigationSkillIdRef.current = null;
    },
  });
};
