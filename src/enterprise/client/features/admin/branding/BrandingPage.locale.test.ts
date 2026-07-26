import { describe, expect, it } from 'vitest';

import enUS from '../../../../../../locales/en-US/admin.json';
import zhCN from '../../../../../../locales/zh-CN/admin.json';

describe('BrandingPage locale contract', () => {
  it('ships the audited en-US and zh-CN outcome copy exactly', () => {
    expect({
      empty: [enUS['branding.empty'], zhCN['branding.empty']],
      generic: [enUS['branding.errors.generic'], zhCN['branding.errors.generic']],
      loading: [enUS['branding.loading'], zhCN['branding.loading']],
      preview: [enUS['branding.preview.frameTitle'], zhCN['branding.preview.frameTitle']],
      publish: [enUS['branding.publish.description'], zhCN['branding.publish.description']],
      readOnly: [enUS['branding.readOnly'], zhCN['branding.readOnly']],
      storage: [enUS['branding.storageUnavailable'], zhCN['branding.storageUnavailable']],
      upload: [enUS['branding.upload.description'], zhCN['branding.upload.description']],
    }).toEqual({
      empty: ['Branding is unavailable.', '品牌配置当前不可用。'],
      generic: [
        'The branding change could not be completed. Check the fields and try again.',
        '品牌配置操作失败，请检查字段后重试。',
      ],
      loading: ['Loading branding draft…', '正在加载品牌配置草稿…'],
      preview: ['Branding preview', '品牌配置预览'],
      publish: [
        'Publish the saved branding draft for everyone.',
        '向所有用户发布已保存的品牌配置草稿。',
      ],
      readOnly: [
        'You can view branding, but you do not have permission to edit it.',
        '你可以查看品牌配置，但没有编辑权限。',
      ],
      storage: [
        'Asset storage is not set up. You can still edit text and use existing image links, but you cannot upload new images.',
        '资源存储尚未设置。你仍可编辑文字并使用现有图片链接，但暂时无法上传新图片。',
      ],
      upload: [
        'We’ll check the image format and size before uploading it.',
        '上传前会检查图片格式和尺寸。',
      ],
    });
  });

  it('does not leave Branding, Web Branding, or Runtime Branding in the zh-CN surface', () => {
    const brandingCopy = Object.entries(zhCN)
      .filter(([key]) => key.startsWith('branding.'))
      .map(([, value]) => value)
      .join('\n');

    expect(brandingCopy).not.toMatch(/\b(?:Branding|Runtime Branding|Web Branding)\b/i);
  });
});
