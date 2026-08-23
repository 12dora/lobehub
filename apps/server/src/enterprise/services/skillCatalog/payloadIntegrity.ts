import type { PlatformSkillResource } from '@/database/schemas/platform';

import type { SkillValidationIssue } from '../../contracts/skillCatalog';
import { skillResourceContentChecksum } from '../../contracts/skillCatalog';
import { containsEnterpriseSecretMaterial } from '../../security/redaction';
import type { SkillCatalogValidationInput, SkillCatalogValidatorOptions } from './validator';
import { hasLoneSurrogate, hasNonCanonicalString, issue } from './validatorIssues';

const DEFAULT_MAX_CONTENT_BYTES = 1024 * 1024;

type PushIssue = (item: SkillValidationIssue) => void;

const validatePayloadEncoding = (input: SkillCatalogValidationInput, pushIssue: PushIssue) => {
  if (hasLoneSurrogate(input.content) || hasLoneSurrogate(input.manifest)) {
    pushIssue(issue('manifest_invalid', ['content'], 'Skill payload contains invalid Unicode'));
  }
  if (hasNonCanonicalString(input.content)) {
    pushIssue(
      issue('manifest_invalid', ['content'], 'Skill content must use NFC and LF line endings'),
    );
  }
  if (hasNonCanonicalString(input.manifest)) {
    pushIssue(
      issue(
        'manifest_invalid',
        ['manifest'],
        'Skill manifest text must use NFC and LF line endings',
      ),
    );
  }
  if (
    hasLoneSurrogate(input.contentRef) ||
    hasLoneSurrogate(input.resources) ||
    hasNonCanonicalString(input.contentRef) ||
    hasNonCanonicalString(input.resources)
  ) {
    pushIssue(
      issue(
        'manifest_invalid',
        ['resources'],
        'Skill resources must contain valid canonical Unicode text',
      ),
    );
  }
};

const validateInlineResources = (input: SkillCatalogValidationInput, pushIssue: PushIssue) => {
  // Managed runtime only executes fully inline content (contentRef must stay null).
  // Reject every non-null value, including corrupted legacy empty-string rows.
  if (input.contentRef !== null && input.contentRef !== undefined) {
    pushIssue(
      issue(
        'non_inline_content',
        ['contentRef'],
        'Managed Skill runtime requires inline content; opaque contentRef is not executable',
      ),
    );
  }
  const resources = input.resources ?? [];
  for (const [index, resource] of resources.entries()) {
    validateInlineResource(resource, index, pushIssue);
  }
};

const validateInlineResource = (
  resource: PlatformSkillResource,
  index: number,
  pushIssue: PushIssue,
) => {
  if (resource.contentRef !== undefined || resource.content === undefined) {
    pushIssue(
      issue(
        'non_inline_content',
        ['resources', index, resource.contentRef !== undefined ? 'contentRef' : 'content'],
        'Managed Skill runtime requires inline resource content',
      ),
    );
  }
  // Independently verify size + checksum against UTF-8 content so stale metadata
  // (e.g. pre-canonicalization / forged digests) cannot pass publication.
  if (resource.content === undefined) return;
  const sizeBytes = new TextEncoder().encode(resource.content).byteLength;
  if (sizeBytes !== resource.sizeBytes) {
    pushIssue(
      issue(
        'manifest_invalid',
        ['resources', index, 'sizeBytes'],
        'Resource sizeBytes must match UTF-8 content bytes',
      ),
    );
  }
  const digest = skillResourceContentChecksum(resource.content);
  if (digest !== resource.checksum) {
    pushIssue(
      issue(
        'checksum_mismatch',
        ['resources', index, 'checksum'],
        'Resource checksum must match SHA-256 of UTF-8 content',
      ),
    );
  }
};

const validateSecretMaterial = (input: SkillCatalogValidationInput, pushIssue: PushIssue) => {
  if (containsEnterpriseSecretMaterial(input.content)) {
    pushIssue(
      issue(
        'secret_material_detected',
        ['content'],
        'Skill payload contains credential-shaped material',
      ),
    );
  }
  if (containsEnterpriseSecretMaterial(input.manifest)) {
    pushIssue(
      issue(
        'secret_material_detected',
        ['manifest'],
        'Skill manifest contains credential-shaped material',
      ),
    );
  }
  if (
    containsEnterpriseSecretMaterial(input.contentRef) ||
    containsEnterpriseSecretMaterial(input.resources)
  ) {
    pushIssue(
      issue(
        'secret_material_detected',
        ['resources'],
        'Skill resources contain credential-shaped material',
      ),
    );
  }
};

export const validateSkillPayloadIntegrity = (
  input: SkillCatalogValidationInput,
  options: SkillCatalogValidatorOptions,
  pushIssue: PushIssue,
) => {
  const contentBytes = new TextEncoder().encode(input.content).byteLength;
  if (contentBytes > (options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES)) {
    pushIssue(
      issue('content_too_large', ['content'], 'Skill content exceeds the UTF-8 byte limit'),
    );
  }
  validatePayloadEncoding(input, pushIssue);
  validateInlineResources(input, pushIssue);
  validateSecretMaterial(input, pushIssue);
};
