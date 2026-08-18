import type {
  AdminBrowserProfileOptions,
  AdminBrowserProfileSummary,
  AdminBrowserProfileUpdateInput,
} from '@/enterprise/client/services/adminSystem';

/** What the platform is running, as option ids. `null` where a stored value has no option left. */
export type BrowserProfileStoredSelection = Pick<
  AdminBrowserProfileSummary,
  'chromeId' | 'computeId' | 'localeId' | 'screenId' | 'systemId' | 'webglId'
>;

/** A complete choice — every dimension resolved to an option the server will accept. */
export type BrowserProfileSelection = Omit<AdminBrowserProfileUpdateInput, 'reason'>;

export const BROWSER_PROFILE_SELECTION_KEYS = [
  'chromeId',
  'systemId',
  'localeId',
  'screenId',
  'computeId',
  'webglId',
] as const satisfies readonly (keyof BrowserProfileSelection)[];

/**
 * The options that are true of the chosen machine.
 *
 * A screen size, a memory size and a GPU only exist on the hardware that ships them: 24 GiB is an
 * Apple-silicon configuration, an Apple GPU cannot appear under Windows, and a 125 % Windows
 * logical resolution is not a panel macOS reports. Offering the whole pool would let an operator
 * assemble a machine that does not exist — which the server rejects, and which upstream would read
 * as an impersonation tell if it did not.
 */
export const visibleBrowserProfileOptions = (
  options: AdminBrowserProfileOptions,
  systemId: string | null | undefined,
): AdminBrowserProfileOptions => {
  const system = options.systems.find((entry) => entry.id === systemId);
  if (!system) return { ...options, compute: [], screens: [], webgl: [] };

  return {
    ...options,
    compute: options.compute.filter(
      (entry) => entry.platform === system.platform && entry.arch === system.arch,
    ),
    screens: options.screens.filter((entry) => entry.platform === system.platform),
    webgl: options.webgl.filter(
      (entry) => entry.platform === system.platform && entry.arch === system.arch,
    ),
  };
};

const resolve = (
  entries: readonly { id: string }[],
  id: string | null | undefined,
): string | undefined =>
  entries.some((entry) => entry.id === id) ? id! : (entries[0]?.id ?? undefined);

/**
 * Settle a possibly-invalid choice onto one the server will accept: keep every id that is still
 * offered, and fall back to the first option that is where it is not. Changing the system is what
 * makes this necessary — the screen, the memory and the GPU that were true of the old machine are
 * usually not options on the new one, and leaving them selected would only produce a rejected save.
 *
 * `undefined` when a dimension has no options at all: there is nothing to save, so nothing to show.
 */
export const repairBrowserProfileSelection = (
  options: AdminBrowserProfileOptions | undefined,
  stored: Partial<BrowserProfileStoredSelection> | undefined,
): BrowserProfileSelection | undefined => {
  if (!options) return undefined;

  const systemId = resolve(options.systems, stored?.systemId);
  const visible = visibleBrowserProfileOptions(options, systemId);

  const chromeId = resolve(options.chrome, stored?.chromeId);
  const computeId = resolve(visible.compute, stored?.computeId);
  const localeId = resolve(options.locales, stored?.localeId);
  const screenId = resolve(visible.screens, stored?.screenId);
  const webglId = resolve(visible.webgl, stored?.webglId);

  if (!chromeId || !computeId || !localeId || !screenId || !systemId || !webglId) return undefined;
  return { chromeId, computeId, localeId, screenId, systemId, webglId };
};

/** Save is only meaningful against what is stored, so this is what lights it up. */
export const isBrowserProfileSelectionDirty = (
  stored: Partial<BrowserProfileStoredSelection> | undefined,
  selection: BrowserProfileSelection | undefined,
): boolean =>
  Boolean(selection) &&
  BROWSER_PROFILE_SELECTION_KEYS.some((key) => stored?.[key] !== selection![key]);

/**
 * Identity of a stored choice, for re-seeding the form. A revalidation that returns the same ids
 * must not throw away an edit in progress — only a change the platform actually made should.
 */
export const browserProfileSelectionKey = (
  stored: Partial<BrowserProfileStoredSelection> | undefined,
): string => BROWSER_PROFILE_SELECTION_KEYS.map((key) => stored?.[key] ?? '').join('|');
