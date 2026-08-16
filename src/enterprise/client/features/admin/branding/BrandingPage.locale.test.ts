import { describe, expect, it } from 'vitest';

import enUS from '../../../../../../locales/en-US/admin.json';
import zhCN from '../../../../../../locales/zh-CN/admin.json';

describe('BrandingPage locale contract', () => {
  it('ships the audited en-US and zh-CN outcome copy exactly', () => {
    expect({
      conflict: [enUS['branding.conflict.title'], zhCN['branding.conflict.title']],
      empty: [enUS['branding.empty'], zhCN['branding.empty']],
      generic: [enUS['branding.errors.generic'], zhCN['branding.errors.generic']],
      immediate: [enUS['branding.fields.immediate'], zhCN['branding.fields.immediate']],
      loading: [enUS['branding.loading'], zhCN['branding.loading']],
      preview: [enUS['branding.preview.frameTitle'], zhCN['branding.preview.frameTitle']],
      readOnly: [enUS['branding.readOnly'], zhCN['branding.readOnly']],
      save: [enUS['branding.save.description'], zhCN['branding.save.description']],
      saved: [enUS['branding.status.saved'], zhCN['branding.status.saved']],
      storage: [enUS['branding.storageUnavailable'], zhCN['branding.storageUnavailable']],
      upload: [enUS['branding.upload.description'], zhCN['branding.upload.description']],
    }).toEqual({
      conflict: ['Branding changed elsewhere', '品牌配置已被其他人修改'],
      empty: ['Branding is unavailable.', '品牌配置当前不可用。'],
      generic: [
        'The branding change could not be completed. Check the fields and try again.',
        '品牌配置操作失败，请检查字段后重试。',
      ],
      immediate: ['Takes effect immediately after saving.', '保存后立即生效。'],
      loading: ['Loading branding…', '正在加载品牌配置…'],
      preview: ['Branding preview', '品牌配置预览'],
      readOnly: [
        'You can view branding, but you do not have permission to edit it.',
        '你可以查看品牌配置，但没有编辑权限。',
      ],
      save: [
        'These values replace the live branding for everyone as soon as you save.',
        '保存后，这些值将立即替换所有人看到的品牌配置。',
      ],
      saved: ['Saved and live.', '已保存并生效'],
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

  it('keeps no draft, publish, or revision-history vocabulary in the shipped copy', () => {
    const keys = Object.keys(enUS).filter((key) => key.startsWith('branding.'));
    const removed = [
      'branding.actions.publish',
      'branding.actions.restoreDraft',
      'branding.history.title',
      'branding.publish.description',
      'branding.recovery.title',
      'branding.rollback.title',
      'branding.status.draftSaved',
      'branding.status.pendingPublish',
    ];

    expect(removed.filter((key) => keys.includes(key))).toEqual([]);
    expect(Object.keys(zhCN).filter((key) => key.startsWith('branding.'))).toEqual(keys);
    expect(
      keys.filter((key) => /draft|publish|revision/i.test(String(enUS[key as keyof typeof enUS]))),
    ).toEqual([]);
  });

  it('does not leave Branding, Web Branding, or Runtime Branding in the zh-CN surface', () => {
    const brandingCopy = Object.entries(zhCN)
      .filter(([key]) => key.startsWith('branding.'))
      .map(([, value]) => value)
      .join('\n');

    expect(brandingCopy).not.toMatch(/\b(?:Branding|Runtime Branding|Web Branding)\b/i);
  });
});
