import type { TaskTemplateConnectorSource } from '@lobechat/const';
import {
  COMPOSIO_APP_TYPES,
  getComposioAppByIdentifier,
  getLobehubConnectorProviderById,
  LOBEHUB_CONNECTOR_PROVIDERS,
} from '@lobechat/const';

export interface TaskTemplateConnectorOption {
  identifier: string;
  label: string;
  source: TaskTemplateConnectorSource;
  /** `<source>:<identifier>` — a single Select value covering both fields. */
  value: string;
}

export const encodeConnectorValue = (connector: {
  identifier: string;
  source: TaskTemplateConnectorSource;
}) => `${connector.source}:${connector.identifier}`;

export const decodeConnectorValue = (
  value: string,
): { identifier: string; source: TaskTemplateConnectorSource } | undefined => {
  const separator = value.indexOf(':');
  if (separator <= 0) return undefined;
  const source = value.slice(0, separator);
  const identifier = value.slice(separator + 1);
  if (!identifier || (source !== 'composio' && source !== 'lobehub')) return undefined;
  return { identifier, source };
};

/**
 * The connectors a task-template card can actually render.
 *
 * Both catalogs are plain constants (7 LobeHub providers + ~23 Composio apps), so the editor can
 * offer a real picker instead of free text — the user-side normalizer silently drops a template
 * whose connector is unknown, which would otherwise hide the whole card with no feedback.
 */
const toOption = (
  identifier: string,
  label: string,
  author: string,
  source: TaskTemplateConnectorSource,
): TaskTemplateConnectorOption => ({
  identifier,
  // Provider names come from the catalogs themselves, never from a literal here.
  label: `${label} · ${author}`,
  source,
  value: encodeConnectorValue({ identifier, source }),
});

export const TASK_TEMPLATE_CONNECTOR_OPTIONS: TaskTemplateConnectorOption[] = [
  ...LOBEHUB_CONNECTOR_PROVIDERS.map((provider) =>
    toOption(provider.id, provider.label, provider.author, 'lobehub'),
  ),
  ...COMPOSIO_APP_TYPES.map((app) => toOption(app.identifier, app.label, app.author, 'composio')),
];

/** Mirrors the server-side contract refine so the editor can block an invalid save locally. */
export const isKnownConnector = (connector: {
  identifier: string;
  source: TaskTemplateConnectorSource;
}): boolean =>
  connector.source === 'lobehub'
    ? Boolean(getLobehubConnectorProviderById(connector.identifier))
    : Boolean(getComposioAppByIdentifier(connector.identifier));

/**
 * Options for one connector row: the current catalog, plus the row's own value when it points at
 * a provider that has since been retired.
 *
 * Without this the Select could not even display a stored historical value — the field would read
 * as empty and the operator would have no idea what they were being asked to replace.
 */
export const buildConnectorOptions = (
  current: { identifier: string; source: TaskTemplateConnectorSource } | undefined,
  retiredLabel: (identifier: string) => string,
): { disabled?: boolean; label: string; value: string }[] => {
  const options = TASK_TEMPLATE_CONNECTOR_OPTIONS.map((option) => ({
    label: option.label,
    value: option.value,
  }));

  if (!current?.identifier || isKnownConnector(current)) return options;
  // Selectable so it stays visible in the trigger; validation blocks saving until it is changed.
  return [
    { label: retiredLabel(current.identifier), value: encodeConnectorValue(current) },
    ...options,
  ];
};
