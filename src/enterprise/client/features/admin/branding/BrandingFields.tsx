'use client';

import { Input, Text } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { createStaticStyles, cssVar } from 'antd-style';
import { type ChangeEvent, memo, useRef } from 'react';

import type {
  AdminBrandingDraft,
  AdminBrandingUploadAssetInput,
} from '@/server/enterprise/contracts/adminBranding';

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
  kind: AssetKind;
  onChange: (value: string | null) => void;
  onUpload: (kind: AssetKind, file: File) => void;
  storageConfigured: boolean;
  uploadLabel: string;
}

const AssetField = memo<AssetFieldProps>((props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) props.onUpload(props.kind, file);
  };
  return (
    <div className={styles.field}>
      <TextField {...props} />
      <div className={styles.upload}>
        <Button
          disabled={props.disabled || !props.storageConfigured}
          onClick={() => inputRef.current?.click()}
        >
          {props.uploadLabel}
        </Button>
        <input
          hidden
          accept=".ico,.jpeg,.jpg,.png,.webp,image/jpeg,image/png,image/webp,image/x-icon"
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
  labels: Record<string, string>;
  onPatch: (patch: Partial<AdminBrandingDraft>) => void;
  onUpload: (kind: AssetKind, file: File) => void;
  storageConfigured: boolean;
}

export const BrandingFields = memo<BrandingFieldsProps>(
  ({ disabled, draft, labels, onPatch, onUpload, storageConfigured }) => {
    const field = (key: keyof AdminBrandingDraft, type?: TextFieldProps['type']) => (
      <TextField
        disabled={disabled}
        label={labels[key]}
        type={type}
        value={draft[key] as string | null}
        onChange={(value) => onPatch({ [key]: value })}
      />
    );
    const asset = (key: 'faviconUrl' | 'iconUrl' | 'logoUrl' | 'ogImageUrl', kind: AssetKind) => (
      <AssetField
        disabled={disabled}
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
            <TextField
              disabled={disabled}
              label={labels.primaryColor}
              value={draft.themeDefaults.primaryColor}
              onChange={(primaryColor) => onPatch({ themeDefaults: { primaryColor } })}
            />
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
        <section className={styles.group}>
          <Text as="h2">{labels.desktop}</Text>
          <Text className={styles.meta}>{labels.rebuildRequired}</Text>
          <div className={styles.grid}>
            <TextField
              disabled={disabled}
              label={labels.desktopProductName}
              meta={labels.rebuildRequired}
              value={draft.desktop.productName}
              onChange={(productName) => onPatch({ desktop: { ...draft.desktop, productName } })}
            />
            <AssetField
              disabled={disabled}
              kind="desktopIcon"
              label={labels.desktopIcon}
              meta={labels.rebuildRequired}
              storageConfigured={storageConfigured}
              uploadLabel={labels.upload}
              value={draft.desktop.iconUrl}
              onChange={(iconUrl) => onPatch({ desktop: { ...draft.desktop, iconUrl } })}
              onUpload={onUpload}
            />
          </div>
        </section>
      </>
    );
  },
);

BrandingFields.displayName = 'BrandingFields';
