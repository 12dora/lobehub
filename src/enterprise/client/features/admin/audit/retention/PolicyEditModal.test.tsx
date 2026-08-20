/**
 * Content-redaction control: `off` is offered, the honest per-level copy is reachable, and
 * widening the policy is acknowledged once on Save — with copy that matches the profile the
 * save will actually leave in place.
 * @vitest-environment happy-dom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import PolicyEditModal from './PolicyEditModal';

const openAuditReasonModal = vi.fn();
const openDangerConfirm = vi.fn();
const onSubmit = vi.fn();

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
  // Real <select>, keyed by its first option so the handle survives a value change.
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
      data-testid={`select-${options?.[0]?.value}`}
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

type Profile = 'strict' | 'standard' | 'off';
type AccessMode = 'disabled' | 'metadata_only' | 'content_allowed';

const basePolicy = {
  contentAccessMode: 'metadata_only' as AccessMode,
  conversationRetentionDays: 90,
  exportArtifactRetentionDays: 30,
  maxExportRows: 10_000,
  maxListWindowDays: 30,
  messageBodyInExport: false,
  operationLogRetentionDays: 90,
  redactionProfile: 'strict' as Profile,
  revision: 1,
};

/** Pass `null` to render before the policy has loaded. */
const renderModal = (overrides?: Partial<typeof basePolicy> | null): ReturnType<typeof render> => {
  const policy = overrides === null ? undefined : { ...basePolicy, ...overrides };
  return render(
    <PolicyEditModal open policy={policy as never} onClose={vi.fn()} onSubmit={onSubmit} />,
  );
};

/** Selects are addressed by their first option, which never changes. */
const redactionSelect = () => screen.getByTestId('select-strict') as HTMLSelectElement;
const contentAccessSelect = () => screen.getByTestId('select-disabled') as HTMLSelectElement;

const save = () => fireEvent.click(screen.getByTestId('policy-save'));

const lastConfirm = () =>
  openDangerConfirm.mock.calls.at(-1)![0] as {
    content?: React.ReactNode;
    onConfirm?: () => void;
    title?: string;
  };

/** Confirm bodies are nodes now; render one to read its text. */
const confirmText = (content: React.ReactNode) => render(<>{content}</>).container;

describe('PolicyEditModal content redaction', () => {
  beforeEach(() => {
    openAuditReasonModal.mockReset();
    openDangerConfirm.mockReset();
    onSubmit.mockReset().mockResolvedValue(undefined);
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

  it('defaultsToStrictBeforeThePolicyLoads', () => {
    renderModal(null);

    // The DB default is 'strict'; starting at 'standard' would let an early save weaken
    // redaction on a policy the operator never actually read.
    expect(redactionSelect().value).toBe('strict');
  });

  it('doesNotInterruptThePickerWhenOffIsSelected', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });

    // The choice is reviewable until Save; confirming mid-form would fire on every
    // exploratory pick and on a draft the operator never submits.
    expect(openDangerConfirm).not.toHaveBeenCalled();
    expect(openAuditReasonModal).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('confirmsBeforeTurningMaskingOff', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    save();

    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    expect(lastConfirm().title).toBe('audit.retention.policy.redactionOffConfirmTitle');
    // The reason modal only opens once the operator has acknowledged the exposure.
    expect(openAuditReasonModal).not.toHaveBeenCalled();

    lastConfirm().onConfirm?.();
    expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
    const reasonOpts = openAuditReasonModal.mock.calls[0]![0] as {
      buildPayload: (reason: string) => { redactionProfile: string };
    };
    expect(reasonOpts.buildPayload('policy review').redactionProfile).toBe('off');
  });

  it('submitsNothingWhenTheOperatorBacksOutOfTheConfirm', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    save();

    // Dismissing the dialog never calls onConfirm — the policy must stay untouched.
    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    expect(openAuditReasonModal).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('savesAStrictOrStandardChoiceWithoutADangerConfirm', () => {
    renderModal();

    fireEvent.change(redactionSelect(), { target: { value: 'standard' } });
    save();

    expect(openDangerConfirm).not.toHaveBeenCalled();
    expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
  });

  it('asksOnceWhenBothContentAccessAndRedactionAreWidened', () => {
    renderModal();

    fireEvent.change(contentAccessSelect(), { target: { value: 'content_allowed' } });
    fireEvent.change(redactionSelect(), { target: { value: 'off' } });
    save();

    // One dialog, one confirm button — two stacked dialogs would train operators to click
    // through the second one without reading it.
    expect(openDangerConfirm).toHaveBeenCalledTimes(1);
    expect(lastConfirm().title).toBe('audit.retention.policy.riskConfirmTitle');

    const body = confirmText(lastConfirm().content);
    // Real list items, not newlines in one string: those collapse to a single run-on line.
    expect(body.querySelectorAll('li')).toHaveLength(2);
    expect(body.textContent).toContain('audit.retention.policy.contentAllowedWarnUnmasked');
    expect(body.textContent).toContain('audit.retention.policy.redactionOffConfirmBody');
  });

  describe('copy follows the profile the save leaves in place', () => {
    it('warnsThatCredentialsAreReadableWhenRedactionIsAlreadyOff', () => {
      renderModal({ redactionProfile: 'off' });

      fireEvent.change(contentAccessSelect(), { target: { value: 'content_allowed' } });
      save();

      expect(openDangerConfirm).toHaveBeenCalledTimes(1);
      expect(lastConfirm().title).toBe('audit.retention.policy.contentAllowedWarnTitle');

      // Promising "credentials stay masked" here would be a lie: nothing masks them, so the
      // body must be the unmasked variant and nothing else.
      const body = confirmText(lastConfirm().content);
      expect(body.textContent).toBe('audit.retention.policy.contentAllowedWarnUnmasked');
    });

    it('keepsTheMaskedWordingWhenRedactionStaysOn', () => {
      renderModal();

      fireEvent.change(contentAccessSelect(), { target: { value: 'content_allowed' } });
      save();

      const body = confirmText(lastConfirm().content);
      expect(body.textContent).toBe('audit.retention.policy.contentAllowedWarn');
    });
  });

  describe('unchanged risky values are not re-confirmed', () => {
    it('doesNotReconfirmContentAccessThatWasAlreadyAllowed', () => {
      renderModal({ contentAccessMode: 'content_allowed' });

      fireEvent.change(redactionSelect(), { target: { value: 'off' } });
      save();

      // Only the redaction change is new, so only that risk is raised.
      expect(openDangerConfirm).toHaveBeenCalledTimes(1);
      expect(lastConfirm().title).toBe('audit.retention.policy.redactionOffConfirmTitle');
      const body = confirmText(lastConfirm().content);
      expect(body.textContent).toBe('audit.retention.policy.redactionOffConfirmBody');
    });

    it('doesNotConfirmWhenNeitherRiskyValueChanges', () => {
      renderModal({ contentAccessMode: 'content_allowed', redactionProfile: 'off' });

      fireEvent.change(screen.getAllByTestId('input-number')[0]!, { target: { value: '45' } });
      save();

      expect(openDangerConfirm).not.toHaveBeenCalled();
      expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
    });

    it('doesNotConfirmWhenTurningRedactionBackOn', () => {
      renderModal({ redactionProfile: 'off' });

      fireEvent.change(redactionSelect(), { target: { value: 'strict' } });
      save();

      // Restoring the mask narrows exposure; a danger dialog there is pure friction.
      expect(openDangerConfirm).not.toHaveBeenCalled();
      expect(openAuditReasonModal).toHaveBeenCalledTimes(1);
    });
  });
});
