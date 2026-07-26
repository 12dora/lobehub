import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';

import en from '../../../../../../../locales/en-US/setting.json';
import zh from '../../../../../../../locales/zh-CN/setting.json';
import { getFileCredUploadErrorMessage } from './FileCredForm';

const structuredInvalidPayload = {
  data: {
    errorData: {
      code: 'PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID',
    },
  },
  message: 'PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID',
};

describe('FileCredForm upload error presentation', () => {
  it.each([
    ['en-US', en, 'The file data is invalid. Select the file again and retry.'],
    ['zh-CN', zh, '文件数据无效，请重新选择文件并重试。'],
  ])('maps the stable upload code to setting copy in %s', (_, locale, expected) => {
    const t = ((key: keyof typeof locale) => locale[key]) as TFunction<'setting'>;

    const message = getFileCredUploadErrorMessage(structuredInvalidPayload, t);

    expect(message).toBe(expected);
    expect(message).not.toContain('PLATFORM_GLOBAL_CREDENTIAL_FILE_PAYLOAD_INVALID');
  });

  it('uses safe generic copy instead of echoing unknown server messages', () => {
    const t = ((key: keyof typeof en) => en[key]) as TFunction<'setting'>;

    expect(getFileCredUploadErrorMessage(new Error('sensitive upstream detail'), t)).toBe(
      'File upload failed',
    );
  });
});
