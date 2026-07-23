import { z } from 'zod';

/** Whether the home sidebar layout is user-customizable or centrally platform-managed. */
export type SidebarLayoutMode = 'platform' | 'user';

/**
 * A concrete sidebar layout: the ordered item keys, which sections are hidden, and
 * (optionally) which accordions are expanded. Item keys are opaque to the server —
 * the client owns the catalog of valid keys and its own built-in defaults.
 */
export const sidebarLayoutConfigSchema = z.object({
  hiddenSidebarSections: z.array(z.string().min(1).max(64)).max(64),
  sidebarExpandedKeys: z.array(z.string().min(1).max(64)).max(64).optional(),
  sidebarItems: z.array(z.string().min(1).max(64)).max(64),
});
export type SidebarLayoutConfig = z.infer<typeof sidebarLayoutConfigSchema>;

/** Admin-facing document: the mode plus the platform layout (null until configured). */
export const platformSidebarLayoutSchema = z
  .object({
    layout: sidebarLayoutConfigSchema.nullable(),
    mode: z.enum(['platform', 'user']),
  })
  .strict();
export type PlatformSidebarLayout = z.infer<typeof platformSidebarLayoutSchema>;

export const DEFAULT_PLATFORM_SIDEBAR_LAYOUT: PlatformSidebarLayout = {
  layout: null,
  mode: 'user',
};

/**
 * User-facing policy projection: whether the platform manages the sidebar and, if so,
 * the layout to apply. `layout` may be null even when managed (not yet configured) — the
 * client then applies its own built-in defaults while still hiding customization controls.
 */
export const sidebarLayoutPolicySchema = z
  .object({
    layout: sidebarLayoutConfigSchema.nullable(),
    managed: z.boolean(),
  })
  .strict();
export type SidebarLayoutPolicy = z.infer<typeof sidebarLayoutPolicySchema>;

export const DEFAULT_SIDEBAR_LAYOUT_POLICY: SidebarLayoutPolicy = {
  layout: null,
  managed: false,
};
