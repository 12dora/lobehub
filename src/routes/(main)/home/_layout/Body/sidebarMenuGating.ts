import type { MenuProps } from '@lobehub/ui';

type MenuItems = MenuProps['items'];
type MenuItem = NonNullable<MenuItems>[number];

/** Menu-item keys that customize / reorder / hide the sidebar layout. */
const SIDEBAR_LAYOUT_MENU_KEYS = new Set(['customizeSidebar', 'hideSection', 'moveDown', 'moveUp']);

const isDivider = (item: MenuItem | undefined): boolean =>
  Boolean(item && (item as { type?: string }).type === 'divider');

/**
 * When the platform manages the sidebar layout, drop the sidebar-layout controls
 * (customize / hide-section / move-up / move-down) from a group-header menu so users
 * cannot re-order or hide groups. Business actions (page size, config, …) are kept.
 * Dividers left leading/trailing/adjacent after the removal are cleaned up.
 */
export const stripSidebarLayoutMenuItems = (items: MenuItems, managed: boolean): MenuItems => {
  if (!managed || !items) return items;

  const kept = items.filter(
    (item) => item && !SIDEBAR_LAYOUT_MENU_KEYS.has(String((item as { key?: unknown }).key)),
  );

  const result: MenuItem[] = [];
  for (const item of kept) {
    if (isDivider(item) && (result.length === 0 || isDivider(result.at(-1)))) continue;
    result.push(item);
  }
  while (result.length > 0 && isDivider(result.at(-1))) result.pop();

  return result;
};
