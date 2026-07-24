'use client';

import { Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useEffect, useRef, useState } from 'react';

import type { RuntimeBranding } from '@/enterprise/client/providers/runtimeBranding';
import type {
  AdminBrandingDraft,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

/**
 * Product-default assets shown as the effective preview when neither the draft
 * nor the published runtime branding provides a URL (built-ins ship as static
 * files, not runtime URLs).
 */
const DEFAULT_ASSET_PREVIEW: Record<'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl', string> = {
  faviconUrl: '/favicon.ico',
  iconUrl: '/icons/icon-192x192.png',
  logoUrl: '/icons/icon-192x192.png',
  ogImageUrl: '/og/og.webp',
};

const styles = createStaticStyles(({ css }) => ({
  field: css`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  `,
  grid: css`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;

    @media (width <= 720px) {
      grid-template-columns: 1fr;
    }
  `,
  group: css`
    display: flex;
    flex-direction: column;
    gap: 14px;

    padding: 16px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    background: ${cssVar.colorBgContainer};
  `,
  label: css`
    font-weight: 600;
  `,
  meta: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  thumbnail: css`
    flex-shrink: 0;

    width: 44px;
    height: 44px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: ${cssVar.borderRadiusLG};

    object-fit: contain;
    background: ${cssVar.colorBgLayout};
  `,
  upload: css`
    display: flex;
    gap: 8px;
    align-items: center;
  `,
}));

type AssetKind = AdminBrandingUploadAssetInput['kind'];

interface TextFieldProps {
  disabled: boolean;
  label: string;
  meta?: string;
  onChange: (value: string | null) => void;
  placeholder?: string;
  type?: 'email' | 'text' | 'url';
  value: string | null;
}

const TextField = memo<TextFieldProps>(
  ({ disabled, label, meta, onChange, placeholder, type, value }) => (
    <label className={styles.field}>
      <span className={styles.label}>{label}</span>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
      <Input
        disabled={disabled}
        placeholder={placeholder}
        type={type}
        value={value ?? ''}
        onChange={(event) => onChange(event.target.value || null)}
      />
    </label>
  ),
);

TextField.displayName = 'BrandingTextField';

interface AssetFieldProps extends Omit<TextFieldProps, 'onChange' | 'type'> {
  /** Effective runtime/default URL shown as preview while the draft is empty. */
  effectiveLabel?: string;
  effectiveUrl?: string;
  kind: AssetKind;
  onChange: (value: string | null) => void;
  onUpload: (kind: AssetKind, file: File) => void;
  storageConfigured: boolean;
  uploadLabel: string;
}

const AssetField = memo<AssetFieldProps>((props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  const previewUrl = props.value ?? props.effectiveUrl;
  const isEffectivePreview = !props.value && Boolean(props.effectiveUrl);
  useEffect(() => {
    setPreviewFailed(false);
  }, [previewUrl]);
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) props.onUpload(props.kind, file);
  };
  return (
    <div className={styles.field}>
      <TextField {...props} placeholder={props.placeholder ?? props.effectiveUrl} />
      <div className={styles.upload}>
        {previewUrl && !previewFailed ? (
          <img
            alt=""
            className={styles.thumbnail}
            src={previewUrl}
            onError={() => setPreviewFailed(true)}
          />
        ) : null}
        {previewUrl && !previewFailed && isEffectivePreview && props.effectiveLabel ? (
          <span className={styles.meta}>{props.effectiveLabel}</span>
        ) : null}
        <Button
          disabled={props.disabled || !props.storageConfigured}
          onClick={() => inputRef.current?.click()}
        >
          {props.uploadLabel}
        </Button>
        <input
          hidden
          accept=".jpeg,.jpg,.png,.webp,image/jpeg,image/png,image/webp"
          ref={inputRef}
          type="file"
          onChange={handleFile}
        />
      </div>
    </div>
  );
});

AssetField.displayName = 'BrandingAssetField';

export interface BrandingFieldsProps {
  disabled: boolean;
  draft: AdminBrandingDraft;
  /** Effective runtime branding — prefiled as placeholder/preview so empty draft fields still show current values. */
  effective?: RuntimeBranding;
  labels: Record<string, string>;
  onPatch: (patch: Partial<AdminBrandingDraft>) => void;
  onUpload: (kind: AssetKind, file: File) => void;
  storageConfigured: boolean;
}

export const BrandingFields = memo<BrandingFieldsProps>(
  ({ disabled, draft, effective, labels, onPatch, onUpload, storageConfigured }) => {
    const field = (key: keyof AdminBrandingDraft, type?: TextFieldProps['type']) => (
      <TextField
        disabled={disabled}
        label={labels[key]}
        placeholder={(effective?.[key as keyof RuntimeBranding] as string | null) ?? undefined}
        type={type}
        value={draft[key] as string | null}
        onChange={(value) => onPatch({ [key]: value })}
      />
    );
    const asset = (key: 'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl', kind: AssetKind) => (
      <AssetField
        disabled={disabled}
        effectiveLabel={labels.effectiveCurrent}
        effectiveUrl={effective?.[key] ?? DEFAULT_ASSET_PREVIEW[key]}
        kind={kind}
        label={labels[key]}
        meta={labels.immediate}
        storageConfigured={storageConfigured}
        uploadLabel={labels.upload}
        value={draft[key]}
        onChange={(value) => onPatch({ [key]: value })}
        onUpload={onUpload}
      />
    );

    return (
      <>
        <section className={styles.group}>
          <Text as="h2">{labels.identity}</Text>
          <div className={styles.grid}>
            {field('name')}
            {field('shortName')}
            {field('legalName')}
            {field('defaultAgentDisplayName')}
            {field('pageTitleTemplate')}
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.assets}</Text>
          <div className={styles.grid}>
            {asset('logoUrl', 'logo')}
            {asset('iconUrl', 'icon')}
            {asset('faviconUrl', 'favicon')}
            {asset('ogImageUrl', 'ogImage')}
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.desktop}</Text>
          <span className={styles.meta}>{labels.rebuildRequired}</span>
          <div className={styles.grid}>
            <TextField
              disabled={disabled}
              label={labels.desktopProductName}
              value={draft.desktop.productName}
              onChange={(value) => onPatch({ desktop: { ...draft.desktop, productName: value } })}
            />
            <AssetField
              disabled={disabled}
              kind="desktopIcon"
              label={labels.desktopIcon}
              meta={labels.rebuildRequired}
              storageConfigured={storageConfigured}
              uploadLabel={labels.upload}
              value={draft.desktop.iconUrl}
              onChange={(value) => onPatch({ desktop: { ...draft.desktop, iconUrl: value } })}
              onUpload={onUpload}
            />
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.theme}</Text>
          <div className={styles.grid}>
            <TextField
              disabled={disabled}
              label={labels.primaryColor}
              placeholder="#1677ff"
              value={draft.themeDefaults.primaryColor}
              onChange={(value) =>
                onPatch({ themeDefaults: { ...draft.themeDefaults, primaryColor: value } })
              }
            />
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.links}</Text>
          <div className={styles.grid}>
            {field('homeUrl', 'url')}
            {field('supportUrl', 'url')}
            {field('privacyUrl', 'url')}
            {field('termsUrl', 'url')}
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.email}</Text>
          <div className={styles.grid}>
            {field('emailSenderName')}
            {field('emailFrom', 'email')}
          </div>
        </section>
      </>
    );
  },
);

BrandingFields.displayName = 'BrandingFields';
