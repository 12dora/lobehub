import { lambdaClient } from '@/libs/trpc/client';

import type {
  AdminSkillArchiveInput,
  AdminSkillCreateInput,
  AdminSkillCreateVersionInput,
  AdminSkillCreateVersionOutput,
  AdminSkillGetDependentsInput,
  AdminSkillGetDependentsOutput,
  AdminSkillGetInput,
  AdminSkillGetOutput,
  AdminSkillGetVersionInput,
  AdminSkillGetVersionOutput,
  AdminSkillListInput,
  AdminSkillListOutput,
  AdminSkillListVersionsInput,
  AdminSkillListVersionsOutput,
  AdminSkillMutationOutput,
  AdminSkillPublicationOutput,
  AdminSkillPublishInput,
  AdminSkillRollbackInput,
  AdminSkillUpdateDraftInput,
  AdminSkillValidateInput,
  AdminSkillValidateOutput,
} from '../features/admin/skills/types';

class AdminSkillsService {
  archive = async (input: AdminSkillArchiveInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.archive.mutate(input);

  create = async (input: AdminSkillCreateInput): Promise<AdminSkillMutationOutput> =>
    lambdaClient.admin.skills.create.mutate(input);

  createVersion = async (
    input: AdminSkillCreateVersionInput,
  ): Promise<AdminSkillCreateVersionOutput> =>
    lambdaClient.admin.skills.createVersion.mutate(input);

  get = async (input: AdminSkillGetInput): Promise<AdminSkillGetOutput> =>
    lambdaClient.admin.skills.get.query(input);

  getDependents = async (
    input: AdminSkillGetDependentsInput,
  ): Promise<AdminSkillGetDependentsOutput> => lambdaClient.admin.skills.getDependents.query(input);

  getVersion = async (input: AdminSkillGetVersionInput): Promise<AdminSkillGetVersionOutput> =>
    lambdaClient.admin.skills.getVersion.query(input);

  list = async (input: AdminSkillListInput): Promise<AdminSkillListOutput> =>
    lambdaClient.admin.skills.list.query(input);

  listVersions = async (
    input: AdminSkillListVersionsInput,
  ): Promise<AdminSkillListVersionsOutput> => lambdaClient.admin.skills.listVersions.query(input);

  publish = async (input: AdminSkillPublishInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.publish.mutate(input);

  rollback = async (input: AdminSkillRollbackInput): Promise<AdminSkillPublicationOutput> =>
    lambdaClient.admin.skills.rollback.mutate(input);

  updateDraft = async (input: AdminSkillUpdateDraftInput): Promise<AdminSkillMutationOutput> =>
    lambdaClient.admin.skills.updateDraft.mutate(input);

  validate = async (input: AdminSkillValidateInput): Promise<AdminSkillValidateOutput> =>
    lambdaClient.admin.skills.validate.mutate(input);
}

export const adminSkillsService = new AdminSkillsService();
