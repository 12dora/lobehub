import type { SkillManifest, SkillValidationIssue } from '../../contracts/skillCatalog';
import { issue } from './validatorIssues';

type PushIssue = (item: SkillValidationIssue) => void;

const collectToolDependencies = (manifest: SkillManifest, pushIssue: PushIssue) => {
  const dependencyByKey = new Map<string, { index: number; optional: boolean }>();
  for (const [index, dependency] of manifest.toolDependencies.entries()) {
    if (dependencyByKey.has(dependency.toolKey)) {
      pushIssue(
        issue(
          'manifest_invalid',
          ['manifest', 'toolDependencies', index],
          'Tool dependency is declared more than once',
        ),
      );
    } else {
      dependencyByKey.set(dependency.toolKey, { index, optional: dependency.optional });
    }
  }
  return dependencyByKey;
};

const collectAllowedTools = (
  allow: SkillManifest['permissions']['tools']['allow'],
  dependencyByKey: Map<string, { index: number; optional: boolean }>,
  pushIssue: PushIssue,
) => {
  const allowed = new Set<string>();
  for (const [index, toolKey] of allow.entries()) {
    if (allowed.has(toolKey)) {
      pushIssue(
        issue(
          'permissions_invalid',
          ['manifest', 'permissions', 'tools', 'allow', index],
          'Allowed Tool is declared more than once',
        ),
      );
    }
    allowed.add(toolKey);
    if (!dependencyByKey.has(toolKey)) {
      pushIssue(
        issue(
          'permissions_invalid',
          ['manifest', 'permissions', 'tools', 'allow', index],
          'Allowed Tool must also be declared as a Tool dependency',
        ),
      );
    }
  }
  return allowed;
};

const validateKnownToolDependencies = (
  dependencyByKey: Map<string, { index: number; optional: boolean }>,
  allowed: Set<string>,
  knownToolKeys: ReadonlySet<string> | undefined,
  pushIssue: PushIssue,
) => {
  for (const [toolKey, dependency] of dependencyByKey) {
    const known = knownToolKeys?.has(toolKey) === true;
    if (!dependency.optional && !allowed.has(toolKey)) {
      pushIssue(
        issue(
          'permissions_invalid',
          ['manifest', 'toolDependencies', dependency.index],
          'Required Tool dependency must be present in the Tool allowlist',
        ),
      );
    }
    if (!known && !dependency.optional) {
      pushIssue(
        issue(
          'unknown_tool_dependency',
          ['manifest', 'toolDependencies', dependency.index],
          'Required Tool dependency is unavailable',
        ),
      );
    } else if (!known && dependency.optional && allowed.has(toolKey)) {
      pushIssue(
        issue(
          'unknown_tool_dependency',
          ['manifest', 'toolDependencies', dependency.index],
          'Optional allowed Tool dependency is currently unavailable',
          'warning',
        ),
      );
    }
  }
};

export const validateSkillPermissions = (
  manifest: SkillManifest,
  knownToolKeys: ReadonlySet<string> | undefined,
  pushIssue: PushIssue,
) => {
  const { network, tools } = manifest.permissions;
  if (network.enabled !== network.allowedHosts.length > 0) {
    pushIssue(
      issue(
        'permissions_invalid',
        ['manifest', 'permissions', 'network'],
        'Network permission and allowed host declarations are inconsistent',
      ),
    );
  }

  const dependencyByKey = collectToolDependencies(manifest, pushIssue);
  const allowed = collectAllowedTools(tools.allow, dependencyByKey, pushIssue);
  validateKnownToolDependencies(dependencyByKey, allowed, knownToolKeys, pushIssue);
};
