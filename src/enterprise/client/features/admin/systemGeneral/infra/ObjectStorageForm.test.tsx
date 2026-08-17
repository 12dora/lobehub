// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { toObjectStorageDraft } from './draft';
import { ObjectStorageForm } from './ObjectStorageForm';
import type { InfraObjectStorageView } from './types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: () => '' }),
  cssVar: new Proxy({}, { get: () => '' }),
}));

vi.mock('@lobehub/ui', () => ({
  Icon: () => <span />,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  Input: (props: Record<string, unknown>) => <input {...props} />,
  InputPassword: (props: Record<string, unknown>) => <input type="password" {...props} />,
  // Mirrors the real control: a labelable <button role="switch"> that takes an id.
  Switch: ({
    checked,
    id,
    onChange,
  }: {
    checked?: boolean;
    id?: string;
    onChange?: (next: boolean) => void;
  }) => (
    <button
      aria-checked={checked}
      id={id}
      role="switch"
      type="button"
      onClick={() => onChange?.(!checked)}
    />
  ),
}));

const view = (overrides: Partial<InfraObjectStorageView> = {}): InfraObjectStorageView => ({
  accessId: 'AKIAFULL',
  errorCategory: null,
  status: 'unknown',
  bucket: 'files',
  enabled: true,
  endpoint: 'https://s3.example.com',
  hasSecretAccessKey: true,
  pathStyle: false,
  previewUrlExpireIn: null,
  publicDomain: null,
  region: 'us-east-1',
  revision: 1,
  setAcl: false,
  source: 'db',
  ...overrides,
});

describe('ObjectStorageForm', () => {
  it('renders the stored configuration and keeps the secret write-only', () => {
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{}}
        onPatch={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('files')).toBeTruthy();
    expect(screen.getByDisplayValue('AKIAFULL')).toBeTruthy();
    const secret = screen.getByPlaceholderText('systemGeneral.secret.storedPlaceholder');
    expect((secret as HTMLInputElement).value).toBe('');
  });

  it('asks for the secret again when the values were seeded from the environment', () => {
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view({ accessId: 'AKIA****MPLE', source: 'env' }))}
        errors={{}}
        onPatch={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('systemGeneral.secret.enterPlaceholder')).toBeTruthy();
    expect(screen.queryByDisplayValue('AKIA****MPLE')).toBeNull();
  });

  it('reports a typed secret as a replacement', () => {
    const onPatch = vi.fn();
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{}}
        onPatch={onPatch}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('systemGeneral.secret.storedPlaceholder'), {
      target: { value: 'next-secret' },
    });
    expect(onPatch).toHaveBeenCalledWith({
      secretAccessKey: { cleared: false, stored: true, value: 'next-secret' },
    });
  });

  it('offers an explicit clear for a stored secret', () => {
    const onPatch = vi.fn();
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{}}
        onPatch={onPatch}
      />,
    );

    fireEvent.click(screen.getByText('systemGeneral.secret.clear'));
    expect(onPatch).toHaveBeenCalledWith({
      secretAccessKey: { cleared: true, stored: true, value: '' },
    });
  });

  it('shows validation messages next to their controls', () => {
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{ bucket: 'Required.', endpoint: 'Enter a valid http(s) URL.' }}
        onPatch={vi.fn()}
      />,
    );

    expect(screen.getByText('Required.')).toBeTruthy();
    expect(screen.getByText('Enter a valid http(s) URL.')).toBeTruthy();
  });

  it('toggles path-style access from its labelled switch', () => {
    const onPatch = vi.fn();
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{}}
        onPatch={onPatch}
      />,
    );

    // The switch is reachable by its visible label, not just by position.
    fireEvent.click(
      screen.getByRole('switch', { name: 'systemGeneral.objectStorage.fields.pathStyle' }),
    );
    expect(onPatch).toHaveBeenCalledWith({ forcePathStyle: true });
  });

  it('associates every control with its visible label and its error', () => {
    render(
      <ObjectStorageForm
        disabled={false}
        draft={toObjectStorageDraft(view())}
        errors={{ bucket: 'Required.' }}
        onPatch={vi.fn()}
      />,
    );

    const bucket = screen.getByLabelText('systemGeneral.objectStorage.fields.bucket');
    expect((bucket as HTMLInputElement).value).toBe('files');
    expect(bucket.getAttribute('aria-invalid')).toBe('true');
    const describedBy = bucket.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe('Required.');

    // A control without an error carries neither attribute.
    const region = screen.getByLabelText('systemGeneral.objectStorage.fields.region');
    expect(region.getAttribute('aria-invalid')).toBeNull();
    expect(region.getAttribute('aria-describedby')).toBeNull();

    expect(
      screen.getByLabelText('systemGeneral.objectStorage.fields.secretAccessKey'),
    ).toBeTruthy();
  });
});
