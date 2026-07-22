'use client';

import { createModal } from '@lobehub/ui/base-ui';
import { t } from 'i18next';

import { isDesktop } from '@/const/version';
import { type AdminToolScope, AdminToolScopeProvider } from '@/features/AdminToolScope';
import { MarketAuthProvider } from '@/layout/AuthProvider/MarketAuth';

import { SkillStoreContent } from './SkillStoreContent';

/**
 * The modal mounts outside the page tree, so the admin org scope (if any) must
 * be re-provided explicitly for store installs to target the platform catalog.
 */
export const createSkillStoreModal = (adminScope?: AdminToolScope | null) =>
  createModal({
    content: (
      <AdminToolScopeProvider value={adminScope ?? null}>
        <MarketAuthProvider isDesktop={isDesktop}>
          <SkillStoreContent />
        </MarketAuthProvider>
      </AdminToolScopeProvider>
    ),
    footer: null,
    title: t('skillStore.title', { ns: 'setting' }),
    width: 'min(80%, 800px)',
  });
