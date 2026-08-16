import type {
  ContentModerationRecord,
  ContentModerationSettingsUpdateConfig,
  ContentModerationSettingsView,
} from '@/types/platform/contentModeration';

/** `getRecord` returns the record plus the live user row (null once the user is deleted). */
export interface ModerationRecordDetail extends ContentModerationRecord {
  user: {
    avatar: string | null;
    email: string | null;
    fullName: string | null;
    username: string | null;
  } | null;
}

/**
 * One selectable platform-hosted model, used by the downgrade target and the LLM-judge
 * pickers. The server exposes the published managed catalog alongside `getSettings`
 * (design §5) — the admin never queries the AI provider routers directly, because
 * MODERATION_READ does not imply AI_PROVIDER_READ.
 */
export interface ModerationCatalogModel {
  /** Optional human label for the model; falls back to the raw id. */
  label?: string;
  model: string;
  provider: string;
  /** Optional human label for the provider; falls back to the raw id. */
  providerLabel?: string;
}

/** Everything the 设置 tab needs in one payload. */
export interface ModerationSettingsBundle {
  /** Published platform-hosted models; empty when the server does not expose a catalog. */
  catalog: ModerationCatalogModel[];
  /** Assignable platform role names for the exempt-roles picker. */
  roles: string[];
  settings: ContentModerationSettingsView;
}

/** The editable half of the settings view (masked keys become keep/add on save). */
export type ModerationDraft = ContentModerationSettingsUpdateConfig;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The server groups the published catalog by provider
 * (`{ provider, providerName, models: [{ id, displayName }] }`); the pickers want one flat row
 * per model. Also accepts an already-flat row so a future contract change stays compatible.
 */
const toCatalogModels = (value: unknown): ModerationCatalogModel[] => {
  const row = asRecord(value);
  if (!row) return [];
  const provider = typeof row.provider === 'string' ? row.provider : null;
  if (!provider) return [];
  const providerLabel =
    typeof row.providerName === 'string'
      ? row.providerName
      : typeof row.providerLabel === 'string'
        ? row.providerLabel
        : undefined;

  if (Array.isArray(row.models)) {
    return row.models
      .map((entry) => {
        const model = asRecord(entry);
        const id = typeof model?.id === 'string' ? model.id : null;
        if (!id) return null;
        const flat: ModerationCatalogModel = {
          label: typeof model?.displayName === 'string' ? model.displayName : undefined,
          model: id,
          provider,
          providerLabel,
        };
        return flat;
      })
      .filter((item): item is ModerationCatalogModel => item !== null);
  }

  const model = typeof row.model === 'string' ? row.model : null;
  if (!model) return [];
  return [
    {
      label: typeof row.label === 'string' ? row.label : undefined,
      model,
      provider,
      providerLabel,
    },
  ];
};

/**
 * Accept both shapes the settings query may take: a wrapper
 * (`{ settings, catalog, roles }`) or the settings view on its own. Keeping the
 * tolerance here means a server-side shape change never leaves the tab blank —
 * the catalog / role pickers degrade to free-form input instead.
 */
export const normalizeModerationSettingsResponse = (raw: unknown): ModerationSettingsBundle => {
  const row = asRecord(raw);
  if (!row) throw new Error('CONTENT_MODERATION_SETTINGS_MALFORMED');

  const inner = asRecord(row.settings) ?? asRecord(row.config);
  const settings = (inner ?? row) as unknown as ContentModerationSettingsView;

  const catalogSource = Array.isArray(row.catalog)
    ? row.catalog
    : Array.isArray(row.models)
      ? row.models
      : [];
  const catalog = catalogSource.flatMap((item) => toCatalogModels(item));

  const roles = Array.isArray(row.roles)
    ? row.roles
        .map((item) => (typeof item === 'string' ? item : asRecord(item)?.name))
        .filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];

  return { catalog, roles, settings };
};

/** `provider/model` — the wire form used by the model-scope filter (design §4.1). */
export const modelScopeKey = (provider: string, model: string): string => `${provider}/${model}`;

/** Inverse of {@link modelScopeKey}; the model half may itself contain slashes. */
export const parseModelScopeKey = (key: string): { model: string; provider: string } | null => {
  const index = key.indexOf('/');
  if (index <= 0 || index === key.length - 1) return null;
  return { model: key.slice(index + 1), provider: key.slice(0, index) };
};
