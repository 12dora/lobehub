// @vitest-environment happy-dom
import { MotionProvider } from '@lobehub/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { motion } from 'motion/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PolicyValueEditor } from './PolicyValueEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('PolicyValueEditor', () => {
  const onChange = vi.fn();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MotionProvider motion={motion}>{children}</MotionProvider>
  );

  beforeEach(() => {
    onChange.mockReset();
  });

  it('renders and updates switch, number, textarea and text editors', () => {
    const { rerender } = render(
      <PolicyValueEditor
        control="switch"
        label="Managed value"
        value={false}
        onChange={onChange}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Managed value' }));
    expect(onChange).toHaveBeenLastCalledWith(true);

    rerender(
      <PolicyValueEditor control="number" label="Managed value" value={2} onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Managed value' }), {
      target: { value: '7' },
    });
    expect(onChange).toHaveBeenLastCalledWith(7);

    rerender(
      <PolicyValueEditor
        control="textarea"
        label="Managed value"
        value="before"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Managed value' }), {
      target: { value: 'after' },
    });
    expect(onChange).toHaveBeenLastCalledWith('after');

    rerender(
      <PolicyValueEditor control="text" label="Managed value" value="old" onChange={onChange} />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Managed value' }), {
      target: { value: 'new' },
    });
    expect(onChange).toHaveBeenLastCalledWith('new');
  });

  it('renders a real select and slider with configured bounds', async () => {
    const { rerender } = render(
      <PolicyValueEditor
        control="select"
        label="Managed value"
        value="a"
        options={[
          { labelKey: 'option.a', value: 'a' },
          { labelKey: 'option.b', value: 'b' },
        ]}
        onChange={onChange}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole('combobox', { name: 'Managed value' }));
    const option = await screen.findByRole('option', { name: 'option.b' });
    fireEvent.pointerDown(option);
    fireEvent.click(option);
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith('b'));

    rerender(
      <PolicyValueEditor
        control="slider"
        label="Managed value"
        max={10}
        min={1}
        step={0.5}
        value={4}
        onChange={onChange}
      />,
    );
    const slider = within(screen.getByRole('group', { name: 'Managed value' })).getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuemin', '1');
    expect(slider).toHaveAttribute('aria-valuemax', '10');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
  });

  it.each(['switch', 'number', 'textarea', 'text', 'slider'])(
    'disables the %s editor for read-only access',
    (control) => {
      const { unmount } = render(
        <PolicyValueEditor
          disabled
          control={control}
          label={`${control} managed value`}
          max={10}
          min={0}
          value={control === 'switch' ? true : 1}
          onChange={onChange}
        />,
        { wrapper },
      );
      if (control === 'slider') {
        const slider = within(
          screen.getByRole('group', { name: `${control} managed value` }),
        ).getByRole('slider');
        expect(slider).toHaveAttribute('aria-disabled', 'true');
      } else {
        expect(screen.getByLabelText(`${control} managed value`)).toBeDisabled();
      }
      unmount();
    },
  );
});
