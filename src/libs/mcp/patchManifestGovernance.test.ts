import { describe, expect, it } from 'vitest';

import {
  type BuiltinGovernanceMatrix,
  patchBuiltinManifestWithGovernance,
} from './patchManifestGovernance';

const manifest = (api: Array<Record<string, unknown> & { name: string }>) =>
  ({ api, identifier: 'lobe-task' }) as any;

describe('patchBuiltinManifestWithGovernance', () => {
  it('blocks disabled tools with an org-policy description + required', () => {
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { createTask: 'disabled' } };
    const out = patchBuiltinManifestWithGovernance(
      manifest([{ description: 'x', name: 'createTask' }]),
      matrix,
    );
    expect(out.api[0].humanIntervention).toBe('required');
    expect(out.api[0].description).toContain('[TOOL DISABLED]');
    expect(out.api[0].description).toContain('organization');
  });

  it('sets humanIntervention required for needs_approval', () => {
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { createTask: 'needs_approval' } };
    const out = patchBuiltinManifestWithGovernance(
      manifest([{ description: 'x', name: 'createTask' }]),
      matrix,
    );
    expect(out.api[0].humanIntervention).toBe('required');
    expect(out.api[0].description).toBe('x');
  });

  it('strips a static required gate when the org explicitly says auto', () => {
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { createTask: 'auto' } };
    const out = patchBuiltinManifestWithGovernance(
      manifest([{ description: 'x', humanIntervention: 'required', name: 'createTask' }]),
      matrix,
    );
    expect(out.api[0].humanIntervention).toBeUndefined();
  });

  it('keeps always (safety-critical) intervention even under an explicit auto', () => {
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { createTask: 'auto' } };
    const out = patchBuiltinManifestWithGovernance(
      manifest([{ description: 'x', humanIntervention: 'always', name: 'createTask' }]),
      matrix,
    );
    expect(out.api[0].humanIntervention).toBe('always');
  });

  it('keeps complex (rule/dynamic) intervention configs under an explicit auto', () => {
    const complex = { dynamic: { policy: 'required', type: 'resolver' } };
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { createTask: 'auto' } };
    const out = patchBuiltinManifestWithGovernance(
      manifest([{ humanIntervention: complex, name: 'createTask' }]),
      matrix,
    );
    expect(out.api[0].humanIntervention).toEqual(complex);
  });

  it('leaves APIs without a matrix entry at their static default (manifest miss)', () => {
    const matrix: BuiltinGovernanceMatrix = { 'lobe-task': { otherApi: 'disabled' } };
    const original = { description: 'x', humanIntervention: 'required', name: 'createTask' };
    const out = patchBuiltinManifestWithGovernance(manifest([original]), matrix);
    expect(out.api[0]).toEqual(original);
  });

  it('returns the manifest untouched when its identifier has no matrix entry', () => {
    const input = manifest([{ description: 'x', name: 'createTask' }]);
    const out = patchBuiltinManifestWithGovernance(input, {
      'lobe-web-browsing': { search: 'disabled' },
    });
    expect(out).toBe(input);
  });
});
