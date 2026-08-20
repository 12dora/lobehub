'use client';

import { Popover } from '@lobehub/ui';
import { createStaticStyles } from 'antd-style';
import { type PropsWithChildren } from 'react';
import { memo, Suspense, useCallback, useMemo, useState } from 'react';

import PanelContent from './PanelContent';
import UpgradeBadge from './UpgradeBadge';
import { useNewVersion } from './useNewVersion';

const styles = createStaticStyles(({ css }) => {
  return {
    popover: css`
      border-radius: 10px;
    `,
    popoverContent: css`
      padding: 0;
    `,
  };
});

const UserPanel = memo<PropsWithChildren>(({ children }) => {
  const hasNewVersion = useNewVersion();
  const [open, setOpen] = useState(false);

  const closePopover = useCallback(() => setOpen(false), []);

  // Stable element: the popup subtree is memoised on `content`, so a fresh node
  // on every render tears the panel down and rebuilds it as `open` flips —
  // visible as a flash on open.
  const content = useMemo(() => <PanelContent closePopover={closePopover} />, [closePopover]);

  return (
    <Suspense fallback={children}>
      <UpgradeBadge showBadge={hasNewVersion}>
        {/*
          `placement`: the trigger sits at the top of the left rail, so `topLeft`
          asked the positioner to open upward and it immediately flipped — that
          flip is the one-frame flicker on open. Opening downward from the chip
          needs no flip, and no `inset-*: !important` override fighting floating-ui.
        */}
        <Popover
          arrow={false}
          content={content}
          open={open}
          placement="bottomLeft"
          trigger="click"
          classNames={{
            root: styles.popover,
            content: styles.popoverContent,
          }}
          onOpenChange={setOpen}
        >
          {children}
        </Popover>
      </UpgradeBadge>
    </Suspense>
  );
});

UserPanel.displayName = 'UserPanel';

export default UserPanel;
