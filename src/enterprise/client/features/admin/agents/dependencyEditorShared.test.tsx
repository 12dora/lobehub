// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FieldLabel } from './dependencyEditorShared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'field' in options ? `${key}|${options.field}` : key,
  }),
}));
vi.mock('antd-style', () => ({
  createStaticStyles: () => new Proxy({}, { get: (_t, key) => String(key) }),
  cssVar: new Proxy({}, { get: () => '' }),
}));
vi.mock('@lobehub/ui/base-ui', () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock('@lobehub/ui', () => ({
  Flexbox: ({ children }: any) => <div>{children}</div>,
  Icon: () => <i />,
  NeuralNetworkLoading: () => null,
  Text: ({ children }: any) => <span>{children}</span>,
  // Only the open state paints the guidance — exactly like the real tooltip.
  Tooltip: ({ children, open, title, onOpenChange }: any) => (
    <span>
      {children}
      {/* Stands in for the library's own hover/press open signal. */}
      <button data-testid="library-open" type="button" onClick={() => onOpenChange?.(true)} />
      {open ? <span role="tooltip">{title}</span> : null}
    </span>
  ),
}));

const renderField = (help?: string, label: string = 'agentCatalog.editor.key') =>
  render(
    <>
      <FieldLabel help={help} htmlFor="field-under-test">
        {label}
      </FieldLabel>
      <input id="field-under-test" />
    </>,
  );

describe('FieldLabel help', () => {
  it('offers no help affordance for a field that has no static guidance', () => {
    renderField();
    expect(screen.queryByRole('button', { name: /helpFor/ })).toBeNull();
  });

  it('exposes the guidance on a real button, named after the field it explains', () => {
    renderField('agentCatalog.editor.keyDesc');
    const trigger = screen.getByRole('button', {
      name: 'agentCatalog.editor.helpFor|agentCatalog.editor.key',
    });
    // A native button: reachable by Tab, activatable by Enter/Space, without a tabindex patch.
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
  });

  it('shows the guidance on FOCUS and hides it again on blur — not pointer-only', () => {
    renderField('agentCatalog.editor.keyDesc');
    const trigger = screen.getByRole('button', {
      name: 'agentCatalog.editor.helpFor|agentCatalog.editor.key',
    });

    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip').textContent).toBe('agentCatalog.editor.keyDesc');
    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still opens from the pointer path the tooltip itself drives', () => {
    renderField('agentCatalog.editor.keyDesc');
    fireEvent.click(screen.getByTestId('library-open'));
    expect(screen.getByRole('tooltip').textContent).toBe('agentCatalog.editor.keyDesc');
  });

  it('keeps the help name out of the control label, and the label bound to its control', () => {
    renderField('agentCatalog.editor.keyDesc');
    const label = document.querySelector('label')!;
    const trigger = screen.getByRole('button', {
      name: 'agentCatalog.editor.helpFor|agentCatalog.editor.key',
    });
    // Inside the <label>, the button's accessible name would leak into the input's own name.
    expect(label.contains(trigger)).toBe(false);
    expect(label.getAttribute('for')).toBe('field-under-test');
  });

  it('falls back to a generic help name when the label is not plain text', () => {
    render(
      <FieldLabel help="agentCatalog.editor.keyDesc">
        <span>agentCatalog.editor.key</span>
      </FieldLabel>,
    );
    expect(screen.getByRole('button', { name: 'agentCatalog.editor.help' })).toBeTruthy();
  });
});
