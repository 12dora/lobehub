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
export type BrowserProfileSelection = Omit<
  AdminBrowserProfileUpdateInput,
  'expectedRevision' | 'reason'
>;

/**
 * A choice in progress. A dimension is `undefined` while it is the operator's to make — a stored
 * option the pools no longer describe is left for them rather than answered on their behalf.
 */
export type BrowserProfileDraft = Partial<BrowserProfileSelection>;

/** What Save posts: the complete choice, plus the revision the form was built from. */
export type BrowserProfileSaveInput = Omit<AdminBrowserProfileUpdateInput, 'reason'>;

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

const offered = (
  entries: readonly { id: string }[],
  id: string | null | undefined,
): string | undefined => (entries.some((entry) => entry.id === id) ? id! : undefined);

/**
 * Seed the form from what is stored. An id the pools no longer describe stays unresolved.
 *
 * The server reports an unmatchable selection as `null` on purpose, and answering it with the first
 * entry of the pool would open the card already changed: an operator who then edits only the locale
 * would also replace the browser build — rotating the identity ChatGPT's session id and the
 * Cloudflare cookie jars are pinned to — having chosen nothing of the sort.
 *
 * `undefined` before the pools arrive: there is nothing to choose from, so nothing to show.
 */
export const adoptBrowserProfileSelection = (
  options: AdminBrowserProfileOptions | undefined,
  stored: Partial<BrowserProfileStoredSelection> | undefined,
): BrowserProfileDraft | undefined => {
  if (!options) return undefined;

  const systemId = offered(options.systems, stored?.systemId);
  const visible = visibleBrowserProfileOptions(options, systemId);

  return {
    chromeId: offered(options.chrome, stored?.chromeId),
    computeId: offered(visible.compute, stored?.computeId),
    localeId: offered(options.locales, stored?.localeId),
    screenId: offered(visible.screens, stored?.screenId),
    systemId,
    webglId: offered(visible.webgl, stored?.webglId),
  };
};

const keepOrRepoint = (
  entries: readonly { id: string }[],
  id: string | undefined,
): string | undefined => {
  if (id === undefined) return undefined;
  return entries.some((entry) => entry.id === id) ? id : entries[0]?.id;
};

/**
 * Settle a draft the operator just changed. Choosing a different machine is what makes this
 * necessary: the screen, the memory and the GPU that were true of the old one are usually not
 * options on the new one, and leaving them selected would only produce a rejected save. Repointing
 * them is the operator's own edit following through, not a guess — so a dimension they have not
 * resolved yet stays unresolved.
 */
export const repairBrowserProfileSelection = (
  options: AdminBrowserProfileOptions | undefined,
  draft: BrowserProfileDraft | undefined,
): BrowserProfileDraft | undefined => {
  if (!options) return undefined;

  const systemId = draft?.systemId;
  const visible = visibleBrowserProfileOptions(options, systemId);

  return {
    chromeId: draft?.chromeId,
    computeId: keepOrRepoint(visible.compute, draft?.computeId),
    localeId: draft?.localeId,
    screenId: keepOrRepoint(visible.screens, draft?.screenId),
    systemId,
    webglId: keepOrRepoint(visible.webgl, draft?.webglId),
  };
};

/** The draft as something Save can post, or `undefined` while a dimension is still unresolved. */
export const completeBrowserProfileSelection = (
  draft: BrowserProfileDraft | undefined,
): BrowserProfileSelection | undefined => {
  if (!draft) return undefined;
  const { chromeId, computeId, localeId, screenId, systemId, webglId } = draft;
  if (!chromeId || !computeId || !localeId || !screenId || !systemId || !webglId) return undefined;
  return { chromeId, computeId, localeId, screenId, systemId, webglId };
};

/**
 * Save is only meaningful against what is stored, so this is what lights it up. A stored id the
 * pools cannot name compares equal to an unresolved one: nothing has been chosen yet.
 */
export const isBrowserProfileSelectionDirty = (
  stored: Partial<BrowserProfileStoredSelection> | undefined,
  selection: BrowserProfileDraft | undefined,
): boolean =>
  Boolean(selection) &&
  BROWSER_PROFILE_SELECTION_KEYS.some(
    (key) => (stored?.[key] ?? null) !== (selection![key] ?? null),
  );

/**
 * Identity of a stored choice, for re-seeding the form. A revalidation that returns the same ids
 * must not throw away an edit in progress — only a change the platform actually made should.
 */
export const browserProfileSelectionKey = (
  stored: Partial<BrowserProfileStoredSelection> | undefined,
): string => BROWSER_PROFILE_SELECTION_KEYS.map((key) => stored?.[key] ?? '').join('|');
