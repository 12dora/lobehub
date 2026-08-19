'use client';

import { confirmModal } from '@lobehub/ui/base-ui';
import { t } from 'i18next';
import { type ReactNode } from 'react';

export interface ForceDisableDependent {
  label: string;
  resourceType: string;
}

export class ForceDisableCancelledError extends Error {
  constructor() {
    super('FORCE_DISABLE_CANCELLED');
    this.name = 'ForceDisableCancelledError';
  }
}

const MAX_LISTED_DEPENDENTS = 8;

const listSentence = (items: readonly string[]): string => {
  if (items.length <= MAX_LISTED_DEPENDENTS) return items.join(', ');
  const shown = items.slice(0, MAX_LISTED_DEPENDENTS).join(', ');
  return `${shown} +${items.length - MAX_LISTED_DEPENDENTS}`;
};

const buildContent = (dependents: readonly ForceDisableDependent[]): ReactNode => {
  const agentTitles = dependents
    .filter((item) => item.resourceType === 'agent')
    .map((item) => item.label);
  const settingPaths = dependents
    .filter((item) => item.resourceType === 'setting')
    .map((item) => item.label);

  return (
    <div>
      {agentTitles.length > 0 ? (
        <p>
          {t('aiCatalog.provider.forceDisable.agents', {
            ns: 'admin',
            titles: listSentence(agentTitles),
          })}
        </p>
      ) : null}
      {settingPaths.length > 0 ? (
        <p>
          {t('aiCatalog.provider.forceDisable.settings', {
            ns: 'admin',
            paths: listSentence(settingPaths),
          })}
        </p>
      ) : null}
    </div>
  );
};

/** Confirm that force-disable will quarantine the listed published dependents. */
export const confirmForceDisableProvider = (
  dependents: readonly ForceDisableDependent[],
): Promise<void> =>
  new Promise((resolve, reject) => {
    confirmModal({
      cancelText: t('aiCatalog.provider.forceDisable.cancel', { ns: 'admin' }),
      content: buildContent(dependents),
      okButtonProps: { danger: true },
      okText: t('aiCatalog.provider.forceDisable.confirm', { ns: 'admin' }),
      onCancel: () => reject(new ForceDisableCancelledError()),
      onOk: () => resolve(),
      title: t('aiCatalog.provider.forceDisable.title', { ns: 'admin' }),
    });
  });
