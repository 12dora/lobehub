import { type SwitchProps } from 'antd';
import { Switch } from 'antd';
import { memo, useState } from 'react';

interface InstantSwitchProps {
  disabled?: boolean;
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
  size?: SwitchProps['size'];
}

const InstantSwitch = memo<InstantSwitchProps>(({ disabled, enabled, onChange, size }) => {
  const [value, setValue] = useState(enabled);
  const [loading, setLoading] = useState(false);
  return (
    <Switch
      disabled={disabled}
      loading={loading}
      size={size}
      value={value}
      onChange={async (next) => {
        const previous = value;
        setLoading(true);
        setValue(next);
        try {
          await onChange(next);
        } catch {
          // Roll back optimistic UI when the write fails (admin/user switches).
          setValue(previous);
        } finally {
          setLoading(false);
        }
      }}
    />
  );
});

export default InstantSwitch;
