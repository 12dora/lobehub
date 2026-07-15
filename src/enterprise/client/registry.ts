import type { RouteObject } from 'react-router';

/**
 * Enterprise module registration surface.
 * Modules expose routes / menus / system checks without patching core files.
 */
export interface EnterpriseModuleRegistration {
  id: string;
  /** Nav items for admin shell (M03+). */
  menuItems?: EnterpriseMenuItem[];
  /** Routes merged into BusinessDesktopRoutesWithoutMainLayout when admin flag is on. */
  routes?: RouteObject[];
  /** System health / readiness checks (M14+). */
  systemChecks?: EnterpriseSystemCheck[];
}

export interface EnterpriseMenuItem {
  id: string;
  labelKey: string;
  path: string;
  /** Permission code required to show the item (server still enforces). */
  permission?: string;
}

export interface EnterpriseSystemCheck {
  id: string;
  labelKey: string;
}

export interface EnterpriseModuleRegistry {
  getMenuItems: () => EnterpriseMenuItem[];
  getRoutes: () => RouteObject[];
  getSystemChecks: () => EnterpriseSystemCheck[];
  list: () => readonly EnterpriseModuleRegistration[];
  register: (module: EnterpriseModuleRegistration) => void;
}

export const createEnterpriseModuleRegistry = (): EnterpriseModuleRegistry => {
  const modules: EnterpriseModuleRegistration[] = [];

  return {
    getMenuItems: () => modules.flatMap((module) => module.menuItems ?? []),
    getRoutes: () => modules.flatMap((module) => module.routes ?? []),
    getSystemChecks: () => modules.flatMap((module) => module.systemChecks ?? []),
    list: () => modules,
    register: (module) => {
      if (modules.some((existing) => existing.id === module.id)) {
        throw new Error(`Enterprise module already registered: ${module.id}`);
      }
      modules.push(module);
    },
  };
};

/** Process-wide registry for client module plugins. */
export const enterpriseModuleRegistry = createEnterpriseModuleRegistry();
