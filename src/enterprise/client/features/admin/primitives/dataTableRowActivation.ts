import type { TableProps } from 'antd';

/**
 * True when the event target is (or sits inside) a *nested* interactive control.
 * The row itself often uses role="link" for keyboard a11y — that must still activate.
 * Nested buttons/links/inputs must not also trigger row activation.
 */
const isInteractiveDescendantTarget = (
  target: EventTarget | null,
  currentTarget: EventTarget | null,
): boolean => {
  if (!(target instanceof Element) || !(currentTarget instanceof Element)) return false;
  const interactive = target.closest(
    'a, button, input, select, textarea, label, [role="button"], [role="link"], [role="menuitem"], [role="checkbox"], [role="switch"], [role="textbox"], [contenteditable="true"]',
  );
  if (!interactive || interactive === currentTarget) return false;
  return currentTarget.contains(interactive);
};

export interface CreateOnRowOptions<T extends object> {
  onRowActivate?: (record: T) => void;
  rowClassName?: (record: T, index: number) => string | undefined;
}

export const createOnRow = <T extends object>({
  onRowActivate,
  rowClassName,
}: CreateOnRowOptions<T>): TableProps<T>['onRow'] =>
  onRowActivate || rowClassName
    ? (record, index) => {
        const extraClassName = rowClassName?.(record, index ?? 0);
        if (!onRowActivate) {
          return extraClassName ? { className: extraClassName } : {};
        }
        return {
          className: extraClassName
            ? `admin-table-row-clickable ${extraClassName}`
            : 'admin-table-row-clickable',
          onClick: (event) => {
            if (event.defaultPrevented) return;
            if (isInteractiveDescendantTarget(event.target, event.currentTarget)) return;
            onRowActivate(record);
          },
          onKeyDown: (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.defaultPrevented) return;
            // Nested controls own their keyboard activation; do not also navigate the row.
            if (isInteractiveDescendantTarget(event.target, event.currentTarget)) return;
            event.preventDefault();
            onRowActivate(record);
          },
          role: 'link',
          tabIndex: 0,
        };
      }
    : undefined;
