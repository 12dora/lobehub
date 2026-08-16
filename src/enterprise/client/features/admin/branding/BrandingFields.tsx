'use client';

import { Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useEffect, useId, useRef, useState } from 'react';

import type { RuntimeBranding } from '@/enterprise/client/providers/runtimeBranding';
import type {
  AdminBrandingPayload,
  AdminBrandingUploadAssetInput,
} from '@/enterprise/client/services/adminBranding';

import { FieldHint, fieldStyles } from './fieldPrimitives';
import { PrimaryColorField } from './PrimaryColorField';

/**
 * Product-default assets shown as the effective preview when neither the edited values
 * nor the published runtime branding provide a URL (built-ins ship as static files,
 * not runtime URLs).
 */
const DEFAULT_ASSET_PREVIEW: Record<'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl', string> = {
  faviconUrl: '/favicon.ico',
  iconUrl: '/icons/icon-192x192.png',
  logoUrl: '/icons/icon-192x192.png',
  ogImageUrl: '/og/og.webp',
};

const styles = createStaticStyles(({ css }) => ({
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
  heading: css`
    display: flex;
    gap: 6px;
    align-items: center;
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
  /** Blocking validation message rendered under the control. */
  error?: string;
  /** Static guidance, shown through the label's help icon. */
  hint?: string;
  label: string;
  onChange: (value: string | null) => void;
  placeholder?: string;
  type?: 'email' | 'text' | 'url';
  value: string | null;
}

const TextField = memo<TextFieldProps>(
  ({ disabled, error, hint, label, onChange, placeholder, type, value }) => {
    const id = useId();
    return (
      <div className={fieldStyles.field}>
        <div className={fieldStyles.labelRow}>
          <label className={fieldStyles.label} htmlFor={id}>
            {label}
          </label>
          {hint ? <FieldHint field={label} title={hint} /> : null}
        </div>
        <Input
          disabled={disabled}
          id={id}
          placeholder={placeholder}
          status={error ? 'error' : undefined}
          type={type}
          value={value ?? ''}
          onChange={(event) => onChange(event.target.value || null)}
        />
        {error ? <span className={fieldStyles.error}>{error}</span> : null}
      </div>
    );
  },
);

TextField.displayName = 'BrandingTextField';

interface AssetFieldProps extends Omit<TextFieldProps, 'onChange' | 'type'> {
  /** Effective runtime/default URL shown as preview while the field is empty. */
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
    <div className={fieldStyles.field}>
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
          <span className={fieldStyles.meta}>{props.effectiveLabel}</span>
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
  branding: AdminBrandingPayload;
  disabled: boolean;
  /** Effective runtime branding — prefilled as placeholder/preview so empty fields still show current values. */
  effective?: RuntimeBranding;
  labels: Record<string, string>;
  onPatch: (patch: Partial<AdminBrandingPayload>) => void;
  onUpload: (kind: AssetKind, file: File) => void;
  storageConfigured: boolean;
}

export const BrandingFields = memo<BrandingFieldsProps>(
  ({ branding, disabled, effective, labels, onPatch, onUpload, storageConfigured }) => {
    const field = (key: keyof AdminBrandingPayload, type?: TextFieldProps['type']) => (
      <TextField
        disabled={disabled}
        error={key === 'name' && !branding.name ? labels.nameRequired : undefined}
        label={labels[key]}
        placeholder={(effective?.[key as keyof RuntimeBranding] as string | null) ?? undefined}
        type={type}
        value={branding[key] as string | null}
        onChange={(value) => onPatch({ [key]: value })}
      />
    );
    const asset = (key: 'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl', kind: AssetKind) => (
      <AssetField
        disabled={disabled}
        effectiveLabel={labels.effectiveCurrent}
        effectiveUrl={effective?.[key] ?? DEFAULT_ASSET_PREVIEW[key]}
        hint={labels.immediate}
        kind={kind}
        label={labels[key]}
        storageConfigured={storageConfigured}
        uploadLabel={labels.upload}
        value={branding[key]}
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
          <div className={styles.heading}>
            <Text as="h2">{labels.desktop}</Text>
            <FieldHint field={labels.desktop} title={labels.rebuildRequired} />
          </div>
          <div className={styles.grid}>
            <TextField
              disabled={disabled}
              label={labels.desktopProductName}
              value={branding.desktop.productName}
              onChange={(value) =>
                onPatch({ desktop: { ...branding.desktop, productName: value } })
              }
            />
            <AssetField
              disabled={disabled}
              kind="desktopIcon"
              label={labels.desktopIcon}
              storageConfigured={storageConfigured}
              uploadLabel={labels.upload}
              value={branding.desktop.iconUrl}
              onChange={(value) => onPatch({ desktop: { ...branding.desktop, iconUrl: value } })}
              onUpload={onUpload}
            />
          </div>
        </section>
        <section className={styles.group}>
          <Text as="h2">{labels.theme}</Text>
          <div className={styles.grid}>
            <PrimaryColorField
              disabled={disabled}
              label={labels.primaryColor}
              value={branding.themeDefaults.primaryColor}
              onChange={(value) =>
                onPatch({ themeDefaults: { ...branding.themeDefaults, primaryColor: value } })
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
