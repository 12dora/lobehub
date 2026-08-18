// @vitest-environment happy-dom
import i18next, { type TFunction } from 'i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import defaultAdmin from '@/locales/default/admin';

import { toastTaskTemplateBulkSummary } from './bulkDelete';

/**
 * The page suites translate with a stub, so they cannot see "1 task templates deleted."
 * This one runs the bulk-delete copy through the REAL `admin` bundle and the real i18next
 * plural resolution, in both the singular and the plural case.
 */
const mocks = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }));

vi.mock('@lobehub/ui/base-ui', () => ({
  toast: { success: mocks.success, warning: mocks.warning },
}));

const i18n = i18next.createInstance();
let t: TFunction<'admin'>;

beforeAll(async () => {
  await i18n.init({
    fallbackLng: 'en-US',
    interpolation: { escapeValue: false },
    lng: 'en-US',
    resources: { 'en-US': { admin: defaultAdmin } },
  });
  t = i18n.getFixedT(null, 'admin') as TFunction<'admin'>;
});

describe('task template bulk-delete copy', () => {
  it('uses the singular form for one row and the plural form for several', () => {
    expect(t('taskTemplateCatalog.bulkDelete.content', { count: 1 })).toBe(
      '1 task template disappears from every user’s recommendations immediately. This cannot be undone.',
    );
    expect(t('taskTemplateCatalog.bulkDelete.content', { count: 3 })).toBe(
      '3 task templates disappear from every user’s recommendations immediately. This cannot be undone.',
    );
  });

  it('reports a single deleted row in the singular', () => {
    toastTaskTemplateBulkSummary({ failed: [], succeeded: 1 }, t);

    expect(mocks.success).toHaveBeenCalledWith('1 task template deleted.');
  });

  it('reports several deleted rows in the plural', () => {
    toastTaskTemplateBulkSummary({ failed: [], succeeded: 2 }, t);

    expect(mocks.success).toHaveBeenCalledWith('2 task templates deleted.');
  });

  it('names the failed row with translated copy, never a raw error code', () => {
    toastTaskTemplateBulkSummary(
      {
        failed: [{ reason: t('taskTemplateCatalog.bulkDelete.reason.conflict'), title: 'Digest' }],
        succeeded: 1,
      },
      t,
    );

    expect(mocks.warning).toHaveBeenCalledWith(
      '1 deleted, 1 failed — Digest: Changed by another administrator',
    );
  });
});
