import { type SwitchProps } from 'antd';
import { Switch } from 'antd';
import { memo, useEffect, useState } from 'react';

interface InstantSwitchProps {
  disabled?: boolean;
  enabled: boolean;
  onChange: (enabled: boolean) => Promise<void>;
  size?: SwitchProps['size'];
}

const InstantSwitch = memo<InstantSwitchProps>(({ disabled, enabled, onChange, size }) => {
  const [value, setValue] = useState(enabled);
  const [loading, setLoading] = useState(false);
  // Follow external changes (another flow flipped the flag server-side, e.g. an admin
  // disconnect that disables the provider) — but never clobber an in-flight optimistic value.
  useEffect(() => {
    if (!loading) setValue(enabled);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
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
