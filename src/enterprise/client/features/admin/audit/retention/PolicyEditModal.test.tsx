/**
 * Content-redaction control: `off` is offered, the honest per-level copy is reachable,
 * and turning masking off is confirmed before the reason modal is opened.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PolicyEditModal from './PolicyEditModal';

const openAuditReasonModal = vi.fn();
const openDangerConfirm = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock('antd-style', () => ({
  createStaticStyles: () =>
    new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : '') }),
  cssVar: {},
}));

vi.mock('@lobehub/ui', () => ({
  Alert: ({ message }: { message?: React.ReactNode }) => <div role="alert">{message}</div>,
  Icon: () => null,
  InputNumber: ({ onChange, value }: { onChange?: (value: number) => void; value?: number }) => (
    <input
      data-testid="input-number"
      value={value}
      onChange={(event) => onChange?.(Number(event.target.value))}
    />
  ),
  Text: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
  // Render the tooltip body inline so the per-level copy is assertable.
  Tooltip: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
    <span>
      {children}
      <span data-testid="tooltip">{title}</span>
    </span>
  ),
}));

vi.mock('@lobehub/ui/base-ui', () => ({
  Modal: ({
    children,
    onOk,
    open,
  }: {
    children?: React.ReactNode;
    onOk?: () => void;
    open?: boolean;
  }) =>
    open ? (
      <div>
        {children}
        <button data-testid="policy-save" type="button" onClick={onOk}>
          save
        </button>
      </div>
    ) : null,
  // Real <select>: the option list is the thing under test.
  Select: ({
    onChange,
    options,
    value,
  }: {
    onChange?: (v: string) => void;
    options?: Array<{ label: string; value: string }>;
    value?: string;
  }) => (
    <select
      data-testid={`select-${value}`}
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {(options ?? []).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
  Switch: () => <input type="checkbox" />,
}));

vi.mock('../shared/openAuditReasonModal', () => ({
  openAuditReasonModal: (opts: unknown) => openAuditReasonModal(opts),
}));

vi.mock('../../primitives/DangerConfirm', () => ({
  openDangerConfirm: (opts: { onConfirm?: () => void }) => openDangerConfirm(opts),
}));

const policy = {
  contentAccessMode: 'metadata_only' as const,
  conversationRetentionDays: 90,
  exportArtifactRetentionDays: 30,
  maxExportRows: 10_000,
  maxListWindowDays: 30,
  messageBodyInExport: false,
  operationLogRetentionDays: 90,
  redactionProfile: 'strict' as const,
  revision: 1,
};

const renderModal = () =>
  render(
    <PolicyEditModal
      open
      policy={policy as never}
      onClose={vi.fn()}
      onSubmit={vi.fn().mockResolvedValue(undefined)}
    />,
  );

/** The redaction Select is the one currently showing the policy's profile. */
const redactionSelect = () => screen.getByTestId(`select-${policy.redactionProfile}`);

/** The content-access Select, identified the same way. */
const contentAccessSelect = () => screen.getByTestId(`select-${policy.contentAccessMode}`);

describe('PolicyEditModal content redaction', () => {
  beforeEach(() => {
    openAuditReasonModal.mockReset();
    openDangerConfirm.mockReset();
  });

  it('offersOffAlongsideStrictAndStandard', () => {
    renderModal();

    const values = [...redactionSelect().querySelectorAll('option')].map(
      (option) => (option as HTMLOptionElement).value,
    );
    expect(values).toEqual(['strict', 'standard', 'off']);
  });

  it('spellsOutWhatEachLevelActuallyMasks', () => {
    renderModal();

    // Strict and Standard currently apply the same credential mask — the copy has to say so
    // rather than implying a graduated scale the code does not implement.
    const tooltip = screen.getAllByTestId('tooltip').at(-1)!;
    expect(tooltip.textContent).toContain('audit.retention.policy.redactionProfileHint.strict');
    expect(tooltip.textContent).toContain('audit.retention.policy.redactionProfileHint.standard');
    expect(tooltip.textContent).toContain('audit.retention.policy.redactionProfileHint.off');
  });

  it('doesNotInterruptThePickerWhenOffIsSelected', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });

    // The choice is reviewable until Save; confirming mid-form would fire on every
    // exploratory pick and on a draft the operator never submits.
    expect(openDangerConfirm).not.toHaveBeenCalled();
    expect(openAuditReasonModal).not.toHaveBeenCalled();
  });

  it('confirmsBeforeTurningMaskingOff', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    fireEvent.click(screen.getByTestId('policy-save'));

    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    const confirmOpts = openDangerConfirm.mock.calls[0]![0] as {
      onConfirm?: () => void;
      title?: string;
    };
    expect(confirmOpts.title).toBe('audit.retention.policy.redactionOffConfirmTitle');
    // The reason modal only opens once the operator has acknowledged the exposure.
    expect(openAuditReasonModal).not.toHaveBeenCalled();

    confirmOpts.onConfirm?.();
    expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
    const reasonOpts = openAuditReasonModal.mock.calls[0]![0] as {
      buildPayload: (reason: string) => { redactionProfile: string };
    };
    expect(reasonOpts.buildPayload('policy review').redactionProfile).toBe('off');
  });

  it('savesAStrictOrStandardChoiceWithoutADangerConfirm', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'standard' } });
    fireEvent.click(screen.getByTestId('policy-save'));

    expect(openDangerConfirm).not.toHaveBeenCalled();
    expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
  });

  it('asksOnceWhenBothContentAccessAndRedactionAreWidened', () => {
    renderModal();

    fireEvent.change(contentAccessSelect(), { target: { value: 'content_allowed' } });
    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    fireEvent.click(screen.getByTestId('policy-save'));

    // One dialog, one confirm button — two stacked dialogs would train operators to click
    // through the second one without reading it.
    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    const confirmOpts = openDangerConfirm.mock.calls[0]![0] as {
      content?: string;
      title?: string;
    };
    expect(confirmOpts.title).toBe('audit.retention.policy.riskConfirmTitle');
    expect(confirmOpts.content).toContain('audit.retention.policy.contentAllowedWarn');
    expect(confirmOpts.content).toContain('audit.retention.policy.redactionOffConfirmBody');
  });

  it('submitsNothingWhenTheOperatorBacksOutOfTheConfirm', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    fireEvent.click(screen.getByTestId('policy-save'));

    // Dismissing the dialog never calls onConfirm — the policy must stay untouched.
    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    expect(openAuditReasonModal).not.toHaveBeenCalled();
  });
});
