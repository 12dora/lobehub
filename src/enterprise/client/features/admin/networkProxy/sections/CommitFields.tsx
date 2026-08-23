'use client';

import { Input, InputNumber } from '@lobehub/ui/base-ui';
import { memo, useEffect, useState } from 'react';

/** Text field that saves on blur / Enter — instant save without a write per keystroke. */
export const CommitInput = memo<{
  disabled: boolean;
  onCommit: (value: string) => void;
  placeholder?: string;
  value: string;
}>(({ disabled, onCommit, placeholder, value }) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };
  return (
    <Input
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
      }}
    />
  );
});
CommitInput.displayName = 'NetworkProxyCommitInput';

export const CommitNumber = memo<{
  disabled: boolean;
  max: number;
  min: number;
  onCommit: (value: number) => void;
  value: number;
}>(({ disabled, max, min, onCommit, value }) => {
  const [draft, setDraft] = useState<number | null>(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft === null || !Number.isFinite(draft) || draft < min || draft > max) {
      setDraft(value);
      return;
    }
    if (draft !== value) onCommit(draft);
  };
  return (
    <InputNumber
      disabled={disabled}
      max={max}
      min={min}
      value={draft}
      onBlur={commit}
      onChange={(next) => setDraft(next)}
    />
  );
});
CommitNumber.displayName = 'NetworkProxyCommitNumber';
