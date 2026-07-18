// @vitest-environment node
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { parse, stringify } from 'yaml';

const execFileAsync = promisify(execFile);

describe('desktop S3 publisher', () => {
  it('performs zero AWS calls when an AIHub bundle fails manifest validation', async () => {
    const action = parse(
      await readFile(
        path.resolve(process.cwd(), '.github/actions/desktop-publish-s3/action.yml'),
        'utf8',
      ),
    );
    const uploadScript = action.runs.steps.find(
      ({ name }: { name?: string }) => name === 'Upload to S3',
    ).run;
    const sandbox = await mkdtemp(path.join(tmpdir(), 'aihub-publish-'));
    const releaseDirectory = path.join(sandbox, 'release');
    const mockBinDirectory = path.join(sandbox, 'bin');
    const awsCallLog = path.join(sandbox, 'aws-calls.log');
    await Promise.all([
      mkdir(releaseDirectory),
      mkdir(mockBinDirectory),
      writeFile(awsCallLog, ''),
    ]);
    await Promise.all([
      symlink(path.resolve(process.cwd(), 'scripts'), path.join(sandbox, 'scripts'), 'dir'),
      writeFile(path.join(releaseDirectory, 'AIHub-1.2.3-setup.exe'), 'installer'),
      writeFile(
        path.join(releaseDirectory, 'latest.yml'),
        stringify({
          files: [{ url: 'https://unapproved.example.com/AIHub-1.2.3-setup.exe' }],
          path: 'AIHub-1.2.3-setup.exe',
          version: '1.2.3',
        }),
      ),
      writeFile(
        path.join(mockBinDirectory, 'aws'),
        '#!/bin/sh\nprintf "called\\n" >> "$AWS_CALL_LOG"\n',
      ),
    ]);
    await chmod(path.join(mockBinDirectory, 'aws'), 0o755);

    try {
      await expect(
        execFileAsync('/bin/bash', ['-c', uploadScript], {
          cwd: sandbox,
          env: {
            ...process.env,
            ARTIFACT_BRAND: 'aihub',
            AWS_ACCESS_KEY_ID: 'test-access-key',
            AWS_CALL_LOG: awsCallLog,
            AWS_REGION: 'us-east-1',
            AWS_SECRET_ACCESS_KEY: 'test-secret-key',
            CHANNEL: 'stable',
            NAMESPACE: 'aihub',
            PATH: `${mockBinDirectory}:${process.env.PATH}`,
            REQUIRE_CONFIG: 'true',
            S3_BUCKET: 'test-bucket',
            S3_ENDPOINT: '',
            VERSION: '1.2.3',
          },
        }),
      ).rejects.toMatchObject({ code: 1 });
      expect(await readFile(awsCallLog, 'utf8')).toBe('');
    } finally {
      await rm(sandbox, { force: true, recursive: true });
    }
  });
});
