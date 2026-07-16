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

const isTextMediaType = (mediaType: string) =>
  mediaType.startsWith('text/') ||
  /^application\/(?:json|javascript|typescript|xml|yaml|x-yaml|x-sh|x-shellscript)$/.test(
    mediaType,
  );

const assertCanonicalRelativePath = (value: string) => {
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
  if (
    segments.some((segment) => {
      const collisionKey = segment.replaceAll(/[. ]+$/g, '').toLowerCase();
      return (
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        segment.startsWith('.') ||
        RESERVED_SEGMENTS.has(collisionKey)
      );
    })
  ) {
    throw new Error(`Unsafe inline Skill resource path: ${value}`);
  }
};

/** Validate the exact text-only payload before it crosses a filesystem or sandbox boundary. */
export const validateInlineSkillResources = (
  resources: InlineSkillResource[],
): ValidatedInlineSkillResource[] => {
  if (resources.length > MAX_INLINE_SKILL_FILES) {
    throw new Error(`Inline Skill resource count exceeds ${MAX_INLINE_SKILL_FILES}`);
  }

  const collisionKeys = new Set<string>();
  let totalBytes = 0;
  const validated: ValidatedInlineSkillResource[] = resources.map((resource) => {
    assertCanonicalRelativePath(resource.path);
    const collisionKey = resource.path.toLowerCase();
    if (collisionKeys.has(collisionKey)) {
      throw new Error(`Duplicate inline Skill resource path: ${resource.path}`);
    }
    collisionKeys.add(collisionKey);

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
