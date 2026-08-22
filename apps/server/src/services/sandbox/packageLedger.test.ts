// @vitest-environment node
import { inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTestDB } from '@/database/core/getTestDB';
import { platformSandboxPackageInstalls } from '@/database/schemas/platform';
import { users } from '@/database/schemas/user';
import type { LobeChatDatabase } from '@/database/type';

import {
  extractPackageInstalls,
  normalizeSandboxPackageName,
  recordSandboxPackageInstalls,
} from './packageLedger';

const db: LobeChatDatabase = await getTestDB();
const userId = 'pspi-ledger-user';

beforeEach(async () => {
  await db.delete(platformSandboxPackageInstalls);
  await db.delete(users).where(inArray(users.id, [userId]));
  await db.insert(users).values({ id: userId });
});

afterEach(async () => {
  await db.delete(platformSandboxPackageInstalls);
  await db.delete(users).where(inArray(users.id, [userId]));
});

describe('normalizeSandboxPackageName', () => {
  it('strips pip extras and version specifiers and folds underscores', () => {
    expect(normalizeSandboxPackageName('requests[socks]==2.3', 'pip')).toBe('requests');
    expect(normalizeSandboxPackageName('Foo_Bar>=1.0', 'pip')).toBe('foo-bar');
    expect(normalizeSandboxPackageName('django@^4.2', 'pip')).toBe('django');
  });

  it('keeps npm scope and strips only the version @', () => {
    expect(normalizeSandboxPackageName('@scope/name@1.2.3', 'npm')).toBe('@scope/name');
    expect(normalizeSandboxPackageName('lodash@4.17.21', 'npm')).toBe('lodash');
    expect(normalizeSandboxPackageName('@scope/name', 'npm')).toBe('@scope/name');
  });

  it('strips apt versions', () => {
    expect(normalizeSandboxPackageName('vim=2:9.0', 'apt')).toBe('vim');
  });
});

describe('extractPackageInstalls', () => {
  it.each([
    ['pip install requests', [{ manager: 'pip', package: 'requests' }]],
    ['pip3 install requests', [{ manager: 'pip', package: 'requests' }]],
    ['python -m pip install requests', [{ manager: 'pip', package: 'requests' }]],
    ['python3 -m pip install requests', [{ manager: 'pip', package: 'requests' }]],
    ['uv pip install requests', [{ manager: 'pip', package: 'requests' }]],
    ['pipx install black', [{ manager: 'pip', package: 'black' }]],
    ['poetry add requests', [{ manager: 'pip', package: 'requests' }]],
    ['npm install lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['npm i lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['npm add lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['pnpm add lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['pnpm install lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['yarn add lodash', [{ manager: 'npm', package: 'lodash' }]],
    ['apt-get install vim', [{ manager: 'apt', package: 'vim' }]],
    ['apt install vim', [{ manager: 'apt', package: 'vim' }]],
  ] as const)('recognizes %s', (command, expected) => {
    expect(extractPackageInstalls(command)).toMatchObject([...expected]);
  });

  it('skips flags, requirement files, editable locals, and VCS/path specs', () => {
    expect(
      extractPackageInstalls(
        'pip install -q --upgrade -U -r requirements.txt -e . git+https://x ./local /abs http://x requests',
      ),
    ).toMatchObject([{ manager: 'pip', package: 'requests' }]);
  });

  it('strips extras/versions and keeps npm scopes', () => {
    expect(extractPackageInstalls('pip install requests[socks]==2.3 pandas')).toMatchObject([
      { manager: 'pip', package: 'requests' },
      { manager: 'pip', package: 'pandas' },
    ]);
    expect(extractPackageInstalls('npm i @scope/name@1.2.3 lodash@4')).toMatchObject([
      { manager: 'npm', package: '@scope/name' },
      { manager: 'npm', package: 'lodash' },
    ]);
  });

  it('caps at 20 packages per command', () => {
    const names = Array.from({ length: 25 }, (_, i) => `pkg${i}`).join(' ');
    const extracted = extractPackageInstalls(`pip install ${names}`);
    expect(extracted).toHaveLength(20);
    expect(extracted.at(-1)?.package).toBe('pkg19');
  });

  it('ignores install lines inside a heredoc', () => {
    const script = `cat <<EOF
pip install requests
EOF
echo done`;
    expect(extractPackageInstalls(script)).toEqual([]);
  });

  it('finds installs inside executeCode strings and jupyter magics', () => {
    const code = `
import os, subprocess
os.system("pip install pandas")
subprocess.run("npm install lodash", shell=True)
!pip install matplotlib
`;
    expect(extractPackageInstalls(code)).toMatchObject([
      { command: 'pip install pandas', manager: 'pip', package: 'pandas' },
      { command: 'npm install lodash', manager: 'npm', package: 'lodash' },
      { command: 'pip install matplotlib', manager: 'pip', package: 'matplotlib' },
    ]);
  });

  it('keeps quoted package names', () => {
    expect(extractPackageInstalls('pip install "requests"')).toMatchObject([
      { manager: 'pip', package: 'requests' },
    ]);
  });

  it('records the install command, not the whole script', () => {
    const [item] = extractPackageInstalls('echo hi && pip install requests pandas && echo bye');
    expect(item?.command).toBe('pip install requests pandas');
    expect(item?.command.includes('echo')).toBe(false);
  });

  it('skips hash comments', () => {
    expect(extractPackageInstalls('# pip install requests\npip install pandas')).toMatchObject([
      { manager: 'pip', package: 'pandas' },
    ]);
  });
});

describe('recordSandboxPackageInstalls', () => {
  it('upserts extracted packages and increments on repeat', async () => {
    await expect(
      recordSandboxPackageInstalls(db, {
        params: { command: 'pip install requests pandas' },
        toolName: 'runCommand',
        userId,
      }),
    ).resolves.toBe(2);

    await expect(
      recordSandboxPackageInstalls(db, {
        params: { command: 'python -m pip install requests' },
        toolName: 'execScript',
        userId,
      }),
    ).resolves.toBe(1);

    const rows = await db.select().from(platformSandboxPackageInstalls);
    expect(rows).toHaveLength(2);
    const requests = rows.find((row) => row.package === 'requests');
    expect(requests?.installCount).toBe(2);
  });

  it('scans executeCode.code and never throws', async () => {
    await expect(
      recordSandboxPackageInstalls(db, {
        params: { code: 'os.system("apt install vim")' },
        toolName: 'executeCode',
        userId,
      }),
    ).resolves.toBe(1);

    await expect(
      recordSandboxPackageInstalls(null as unknown as LobeChatDatabase, {
        params: { command: 'pip install requests' },
        toolName: 'runCommand',
        userId,
      }),
    ).resolves.toBe(0);
  });

  it('returns 0 for unknown tools and missing user', async () => {
    await expect(
      recordSandboxPackageInstalls(db, {
        params: { command: 'pip install requests' },
        toolName: 'writeFile',
        userId,
      }),
    ).resolves.toBe(0);
    await expect(
      recordSandboxPackageInstalls(db, {
        params: { command: 'pip install requests' },
        toolName: 'runCommand',
      }),
    ).resolves.toBe(0);
  });
});
