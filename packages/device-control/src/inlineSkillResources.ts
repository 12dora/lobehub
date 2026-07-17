export const MAX_INLINE_SKILL_FILES = 100;
export const MAX_INLINE_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_INLINE_SKILL_TOTAL_BYTES = 8 * 1024 * 1024;

const RESERVED_SEGMENTS = new Set([
  '.git',
  '.prepared',
  'aux',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'con',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
  'nul',
  'prn',
  'skill.md',
  'skill.zip',
]);

export interface InlineSkillResource {
  checksum: string;
  content?: string;
  contentRef?: string;
  mediaType: string;
  path: string;
  sizeBytes: number;
}

export type ValidatedInlineSkillResource = Omit<InlineSkillResource, 'content' | 'contentRef'> & {
  content: string;
  contentRef?: never;
};

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

const unicodeCaseFold = (value: string) =>
  value.normalize('NFKC').toLowerCase().replaceAll('ß', 'ss').replaceAll('ς', 'σ');

const isTextMediaType = (mediaType: string) =>
  mediaType.startsWith('text/') ||
  /^application\/(?:json|javascript|typescript|xml|yaml|x-yaml|x-sh|x-shellscript)$/.test(
    mediaType,
  );

export const canonicalInlineSkillPathKey = (value: string) => {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.normalize('NFC') !== value ||
    value.normalize('NFKC') !== value
  ) {
    throw new Error(`Unsafe inline Skill resource path: ${value}`);
  }

  const segments = value.split('/');
  const keys = segments.map((segment) => {
    const collisionKey = unicodeCaseFold(segment);
    const windowsDeviceName = collisionKey.split('.')[0];
    if (
      segment.length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment.startsWith('.') ||
      /[. ]$/.test(segment) ||
      /[<>:"|?*]/.test(segment) ||
      [...segment].some((character) => character.charCodeAt(0) < 32) ||
      RESERVED_SEGMENTS.has(collisionKey) ||
      RESERVED_SEGMENTS.has(windowsDeviceName)
    ) {
      throw new Error(`Unsafe inline Skill resource path: ${value}`);
    }
    return collisionKey;
  });
  return keys.join('/');
};

const assertNoPathTreeConflicts = (pathKeys: string[], displayPaths: string[]) => {
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const [index, key] of pathKeys.entries()) {
    if (files.has(key) || directories.has(key)) {
      throw new Error(`Duplicate inline Skill resource path: ${displayPaths[index]}`);
    }
    const segments = key.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const parent = segments.slice(0, depth).join('/');
      if (files.has(parent)) {
        throw new Error(`Conflicting inline Skill resource path: ${displayPaths[index]}`);
      }
      directories.add(parent);
    }
    if (directories.has(key)) {
      throw new Error(`Conflicting inline Skill resource path: ${displayPaths[index]}`);
    }
    files.add(key);
  }
};

export const validateInlineSkillResourcePaths = (paths: string[]) => {
  const keys = paths.map(canonicalInlineSkillPathKey);
  assertNoPathTreeConflicts(keys, paths);
  return keys;
};

/** Validate the exact text-only payload before it crosses a filesystem or sandbox boundary. */
export const validateInlineSkillResources = (
  resources: InlineSkillResource[],
): ValidatedInlineSkillResource[] => {
  if (resources.length > MAX_INLINE_SKILL_FILES) {
    throw new Error(`Inline Skill resource count exceeds ${MAX_INLINE_SKILL_FILES}`);
  }

  validateInlineSkillResourcePaths(resources.map((resource) => resource.path));
  let totalBytes = 0;
  const validated: ValidatedInlineSkillResource[] = resources.map((resource) => {
    if (resource.content === undefined || resource.contentRef !== undefined) {
      throw new Error(`Inline Skill resource must contain verified text: ${resource.path}`);
    }
    if (!isTextMediaType(resource.mediaType)) {
      throw new Error(`Inline Skill resource must use a text media type: ${resource.path}`);
    }
    const actualBytes = byteLength(resource.content);
    if (
      actualBytes !== resource.sizeBytes ||
      actualBytes > MAX_INLINE_SKILL_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(resource.checksum)
    ) {
      throw new Error(`Inline Skill resource integrity check failed: ${resource.path}`);
    }
    totalBytes += actualBytes;
    if (totalBytes > MAX_INLINE_SKILL_TOTAL_BYTES) {
      throw new Error(`Inline Skill resources exceed ${MAX_INLINE_SKILL_TOTAL_BYTES} bytes`);
    }
    return {
      checksum: resource.checksum,
      content: resource.content,
      mediaType: resource.mediaType,
      path: resource.path,
      sizeBytes: resource.sizeBytes,
    };
  });

  return validated.sort((left, right) => (left.path < right.path ? -1 : 1));
};

export interface InlineSkillOperationPayload {
  resources: InlineSkillResource[];
  skillContent: string;
}

/** Count every SKILL.md plus every resource across the complete activated operation. */
export const validateInlineSkillOperationPayloads = (payloads: InlineSkillOperationPayload[]) => {
  let totalFiles = 0;
  let totalBytes = 0;
  return payloads.map((payload) => {
    const skillBytes = byteLength(payload.skillContent);
    if (skillBytes > MAX_INLINE_SKILL_FILE_BYTES) {
      throw new Error('Inline Skill content exceeds the per-file byte limit');
    }
    const resources = validateInlineSkillResources(payload.resources);
    totalFiles += resources.length + 1;
    totalBytes += skillBytes + resources.reduce((sum, resource) => sum + resource.sizeBytes, 0);
    if (totalFiles > MAX_INLINE_SKILL_FILES) {
      throw new Error(`Inline Skill operation file count exceeds ${MAX_INLINE_SKILL_FILES}`);
    }
    if (totalBytes > MAX_INLINE_SKILL_TOTAL_BYTES) {
      throw new Error(`Inline Skill operation exceeds ${MAX_INLINE_SKILL_TOTAL_BYTES} bytes`);
    }
    return { resources, skillContent: payload.skillContent };
  });
};
