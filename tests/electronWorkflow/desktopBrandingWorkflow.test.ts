// @vitest-environment node
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse } from 'yaml';

describe('AIHub desktop release workflow', () => {
  it('is manual-only, protected, and requires an explicit confirmation gate', async () => {
    const workflow = parse(
      await readFile(
        path.resolve(process.cwd(), '.github/workflows/release-desktop-aihub.yml'),
        'utf8',
      ),
    );

    expect(workflow.on).toEqual({ workflow_dispatch: expect.any(Object) });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.preflight.environment).toBe('aihub-desktop-release');
    expect(workflow.jobs.preflight.steps[0].run).toContain('RELEASE-AIHUB-DESKTOP');
    expect(workflow.jobs.preflight.steps[0].run).toContain('github.ref_name');
    expect(workflow.jobs.publish.if).toBe('inputs.publish');
  });

  it('uses only the AIHub profile, protected assets, and isolated update namespace', async () => {
    const workflowSource = await readFile(
      path.resolve(process.cwd(), '.github/workflows/release-desktop-aihub.yml'),
      'utf8',
    );

    expect(workflowSource).toContain('DESKTOP_BRAND: aihub');
    expect(workflowSource).toContain("DESKTOP_DISABLE_PROTOCOL_REGISTRATION: '1'");
    expect(workflowSource).toContain('AIHUB_DESKTOP_APP_ID');
    expect(workflowSource).toContain('AIHUB_DESKTOP_ICON_PNG_SHA256');
    expect(workflowSource).toContain('AIHUB_APPLE_CERTIFICATE_BASE64');
    expect(workflowSource).toContain('AIHUB_WINDOWS_CERTIFICATE_BASE64');
    expect(workflowSource).toContain('namespace: aihub');
    expect(workflowSource).toContain("require-config: 'true'");
    expect(workflowSource).toContain('Required AIHub Apple signing');
    expect(workflowSource).toContain('Required AIHub Windows signing');
    expect(workflowSource).not.toContain('LOBEHUB_');
    expect(workflowSource).not.toContain('softprops/action-gh-release');
  });

  it('keeps namespaced S3 publishing optional for existing LobeHub workflows', async () => {
    const actionSource = await readFile(
      path.resolve(process.cwd(), '.github/actions/desktop-publish-s3/action.yml'),
      'utf8',
    );

    expect(actionSource).toContain("default: 'merged-release'");
    expect(actionSource).toContain('TARGET_PREFIX="${NAMESPACE:+$NAMESPACE/}$CHANNEL"');
    expect(actionSource).toContain('s3://$S3_BUCKET/$TARGET_PREFIX/$VERSION/');
    expect(actionSource).toContain('REQUIRE_CONFIG');
  });
});
