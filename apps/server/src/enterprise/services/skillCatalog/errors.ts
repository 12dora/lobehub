import type { SkillValidationIssue } from '../../contracts/skillCatalog';

export class SkillCatalogNotFoundError extends Error {
  constructor() {
    super('Skill catalog resource was not found');
    this.name = 'SkillCatalogNotFoundError';
  }
}

export class SkillCatalogValidationError extends Error {
  constructor(readonly issues: SkillValidationIssue[]) {
    super('Skill catalog validation failed');
    this.name = 'SkillCatalogValidationError';
  }
}

export class SkillCatalogInvalidCursorError extends Error {
  constructor() {
    super('Skill catalog cursor is invalid');
    this.name = 'SkillCatalogInvalidCursorError';
  }
}
