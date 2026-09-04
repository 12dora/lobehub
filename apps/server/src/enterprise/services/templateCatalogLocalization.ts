import { DEFAULT_LANG } from '@/const/locale';
import type {
  PlatformAgentTemplateRecord,
  PlatformTaskTemplateRecord,
} from '@/database/models/platform';
import type { TaskTemplateLibraryLocale } from '@/server/services/taskTemplate/library';
import {
  resolveTaskTemplateLibraryLocale,
  TASK_TEMPLATE_LIBRARY,
  TASK_TEMPLATE_LIBRARY_LOCALES,
} from '@/server/services/taskTemplate/library';

import type { BuiltInAgentTemplateLocale } from '../routers/admin/builtInAgentTemplates';
import {
  BUILTIN_AGENT_TEMPLATE_LOCALES,
  builtInAgentTemplatesForLocale,
  resolveBuiltInAgentTemplateLocale,
} from '../routers/admin/builtInAgentTemplates';

interface AgentCatalogText {
  description: string;
  systemRole: string;
  title: string;
}

interface TaskCatalogText {
  description: string;
  instruction: string;
  title: string;
}

/**
 * Same grammar as first-run seed: an explicit tag wins, then `DEFAULT_LANG` env, then en-US.
 * Unknown tags are forwarded — catalog resolvers (not this helper) map them onto a bundled locale.
 */
const resolveRequestedLocale = (locale?: string): string => {
  const explicit = locale?.trim();
  if (explicit) return explicit;
  const fromEnv = process.env.DEFAULT_LANG?.trim();
  if (fromEnv) return fromEnv;
  return DEFAULT_LANG;
};

const normalizeText = (value: string | null | undefined): string => (value ?? '').trim();

const sameText = (left: string | null | undefined, right: string | null | undefined): boolean =>
  normalizeText(left) === normalizeText(right);

const agentCatalogCache = new Map<BuiltInAgentTemplateLocale, Map<string, AgentCatalogText>>();
const taskCatalogCache = new Map<TaskTemplateLibraryLocale, Map<string, TaskCatalogText>>();

const agentCatalogFor = (locale: BuiltInAgentTemplateLocale): Map<string, AgentCatalogText> => {
  const cached = agentCatalogCache.get(locale);
  if (cached) return cached;

  const map = new Map<string, AgentCatalogText>();
  for (const row of builtInAgentTemplatesForLocale(locale)) {
    map.set(row.identifier, {
      description: row.description,
      systemRole: row.systemRole,
      title: row.title,
    });
  }
  agentCatalogCache.set(locale, map);
  return map;
};

const taskCatalogFor = (locale: TaskTemplateLibraryLocale): Map<string, TaskCatalogText> => {
  const cached = taskCatalogCache.get(locale);
  if (cached) return cached;

  const map = new Map<string, TaskCatalogText>();
  for (const entry of TASK_TEMPLATE_LIBRARY) {
    const text = entry.text[locale] ?? entry.text['en-US'];
    map.set(entry.identifier, {
      description: text.description,
      instruction: text.instruction,
      title: text.title,
    });
  }
  taskCatalogCache.set(locale, map);
  return map;
};

const agentTextEquals = (row: PlatformAgentTemplateRecord, text: AgentCatalogText): boolean =>
  sameText(row.title, text.title) &&
  sameText(row.description, text.description) &&
  sameText(row.systemRole, text.systemRole);

const taskTextEquals = (row: PlatformTaskTemplateRecord, text: TaskCatalogText): boolean =>
  sameText(row.title, text.title) &&
  sameText(row.description, text.description) &&
  sameText(row.instruction, text.instruction);

const overlayOneAgent = (
  row: PlatformAgentTemplateRecord,
  target: BuiltInAgentTemplateLocale,
  targetText: AgentCatalogText,
): PlatformAgentTemplateRecord => {
  // Already showing the requested locale — keep the original object.
  if (agentTextEquals(row, targetText)) return row;

  for (const locale of BUILTIN_AGENT_TEMPLATE_LOCALES) {
    if (locale === target) continue;
    const candidate = agentCatalogFor(locale).get(row.identifier);
    if (candidate && agentTextEquals(row, candidate)) {
      return {
        ...row,
        description: targetText.description,
        systemRole: targetText.systemRole,
        title: targetText.title,
      };
    }
  }

  return row;
};

const overlayOneTask = (
  row: PlatformTaskTemplateRecord,
  target: TaskTemplateLibraryLocale,
  targetText: TaskCatalogText,
): PlatformTaskTemplateRecord => {
  if (taskTextEquals(row, targetText)) return row;

  for (const locale of TASK_TEMPLATE_LIBRARY_LOCALES) {
    if (locale === target) continue;
    const candidate = taskCatalogFor(locale).get(row.identifier);
    if (candidate && taskTextEquals(row, candidate)) {
      return {
        ...row,
        description: targetText.description,
        instruction: targetText.instruction,
        title: targetText.title,
      };
    }
  }

  return row;
};

/**
 * Read-time locale overlay for untouched built-in agent templates.
 *
 * A row is untouched when its `identifier` is in the bundled catalog and title / description /
 * systemRole equal that entry in any supported locale (trim-insensitive; empty values are equal).
 * Edited and unknown-identifier rows are returned as-is. Never writes to the database.
 */
export const overlayAgentTemplateLocale = (
  rows: readonly PlatformAgentTemplateRecord[],
  locale?: string,
): PlatformAgentTemplateRecord[] => {
  if (rows.length === 0) return rows as PlatformAgentTemplateRecord[];

  const target = resolveBuiltInAgentTemplateLocale(resolveRequestedLocale(locale));
  const catalog = agentCatalogFor(target);
  let changed = false;

  const next = rows.map((row) => {
    const targetText = catalog.get(row.identifier);
    if (!targetText) return row;
    const overlaid = overlayOneAgent(row, target, targetText);
    if (overlaid !== row) changed = true;
    return overlaid;
  });

  return changed ? next : (rows as PlatformAgentTemplateRecord[]);
};

/**
 * Read-time locale overlay for untouched bundled task templates.
 *
 * Same content-equality predicate as {@link overlayAgentTemplateLocale} over title / description /
 * instruction. Cron, connectors, enabled, order, and revision are never rewritten.
 */
export const overlayTaskTemplateLocale = (
  rows: readonly PlatformTaskTemplateRecord[],
  locale?: string,
): PlatformTaskTemplateRecord[] => {
  if (rows.length === 0) return rows as PlatformTaskTemplateRecord[];

  const target = resolveTaskTemplateLibraryLocale(resolveRequestedLocale(locale));
  const catalog = taskCatalogFor(target);
  let changed = false;

  const next = rows.map((row) => {
    const targetText = catalog.get(row.identifier);
    if (!targetText) return row;
    const overlaid = overlayOneTask(row, target, targetText);
    if (overlaid !== row) changed = true;
    return overlaid;
  });

  return changed ? next : (rows as PlatformTaskTemplateRecord[]);
};
