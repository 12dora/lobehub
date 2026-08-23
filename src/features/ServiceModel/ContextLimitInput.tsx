'use client';

import { InputNumber } from '@lobehub/ui';
import { ConfigProvider } from 'antd';
import { memo, useEffect, useState } from 'react';

interface ContextLimitInputProps {
  canManage: boolean;
  onCommit: (value: number | undefined) => void;
  placeholder?: string;
  value?: number;
}

/**
 * Local-edit InputNumber that commits on blur / Enter only (avoids per-keystroke publish).
 * Clear (empty) commits `undefined` so callers can map to registry null.
 */
const ContextLimitInput = memo<ContextLimitInputProps>(
  ({ canManage, onCommit, placeholder, value }) => {
    const [draft, setDraft] = useState<number | null | undefined>(value);

    useEffect(() => {
      setDraft(value);
    }, [value]);

    const commit = () => {
      if (!canManage) return;
      const next = typeof draft === 'number' ? draft : undefined;
      const prev = typeof value === 'number' ? value : undefined;
      if (next === prev) return;
      onCommit(next);
    };

    return (
      <ConfigProvider theme={{ token: { controlHeight: 32 } }}>
        <InputNumber
          disabled={!canManage}
          min={1}
          placeholder={placeholder}
          // Left-aligned under the model select. `alignSelf` used to be inert on the user side
          // (managed metas wrap the control in a plain div) and only applied on admin — which
          // made the two surfaces disagree.
          style={{ width: 180 }}
          value={draft as number | undefined}
          onBlur={commit}
          onChange={(next) => setDraft(typeof next === 'number' ? next : null)}
          onPressEnter={commit}
        />
      </ConfigProvider>
    );
  },
);

ContextLimitInput.displayName = 'ContextLimitInput';

export default ContextLimitInput;
