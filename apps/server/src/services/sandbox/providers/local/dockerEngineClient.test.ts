import { afterEach, describe, expect, it } from 'vitest';

import { FakeDockerEngine } from './__tests__/fakeDockerEngine';
import { DockerEngineClient, DockerEngineError, parseDockerEndpoint } from './dockerEngineClient';
import { extractTarFile, packTarFile } from './tarArchive';

describe('parseDockerEndpoint', () => {
  it('prefers tcp hosts over the default unix socket', () => {
    expect(
      parseDockerEndpoint({ host: 'tcp://127.0.0.1:2375', socketPath: '/var/run/docker.sock' }),
    ).toEqual({
      hostname: '127.0.0.1',
      kind: 'tcp',
      port: 2375,
    });
  });

  it('parses unix:// and bare socket paths', () => {
    expect(parseDockerEndpoint({ host: 'unix:///tmp/docker.sock' })).toEqual({
      kind: 'socket',
      socketPath: '/tmp/docker.sock',
    });
    expect(parseDockerEndpoint({ socketPath: '/custom/docker.sock' })).toEqual({
      kind: 'socket',
      socketPath: '/custom/docker.sock',
    });
  });
});

describe('DockerEngineClient', () => {
  const engines: FakeDockerEngine[] = [];

  afterEach(async () => {
    await Promise.all(engines.splice(0).map(async (engine) => engine.close()));
  });

  const start = async () => {
    const fake = new FakeDockerEngine();
    fake.addImage('aihub-sandbox:latest');
    await fake.listen();
    engines.push(fake);
    const client = new DockerEngineClient({ socketPath: fake.socketPath });
    return { client, fake };
  };

  it('pings, creates, starts, exec-demultiplexes, and removes a container', async () => {
    const { client, fake } = await start();

    await client.ping();
    await expect(client.imageInspect('aihub-sandbox:latest')).resolves.toMatchObject({
      Id: expect.stringContaining('aihub-sandbox'),
    });

    await client.volumeCreate('vol-1');
    const created = await client.containerCreate('box-1', {
      Cmd: ['sleep', 'infinity'],
      HostConfig: { NetworkMode: 'bridge' },
      Image: 'aihub-sandbox:latest',
    });
    await client.containerStart(created.Id);
    const inspect = await client.containerInspect(created.Id);
    expect(inspect.State.Running).toBe(true);

    const exec = await client.execCreate(created.Id, { Cmd: ['sh', '-c', '__demux__'] });
    const started = await client.execStart(exec.Id, { containerId: created.Id, timeoutMs: 2000 });
    expect(started.stdout.toString('utf8')).toBe('out-data');
    expect(started.stderr.toString('utf8')).toBe('err-data');
    expect(started.timedOut).toBe(false);

    const execInfo = await client.execInspect(exec.Id);
    expect(execInfo.ExitCode).toBe(0);

    await client.containerRemove(created.Id, { force: true });
    expect(fake.containerByNameOrId(created.Id)).toBeUndefined();
  });

  it('times out a hanging exec stream without using ExecInspect.Pid', async () => {
    const { client, fake } = await start();
    const created = await client.containerCreate('box-timeout', { Image: 'aihub-sandbox:latest' });
    await client.containerStart(created.Id);

    const exec = await client.execCreate(created.Id, { Cmd: ['sh', '-c', 'HANG'] });
    const started = await client.execStart(exec.Id, {
      timeoutMs: 150,
    });

    expect(started.timedOut).toBe(true);
    expect([...fake.execs.values()].some((item) => item.cmd[0] === 'kill')).toBe(false);
  });

  it('drains image pull progress and surfaces pull errors', async () => {
    const { client, fake } = await start();
    fake.pullShouldFail = true;
    await expect(client.imagePull('missing:latest')).rejects.toBeInstanceOf(DockerEngineError);
    fake.pullShouldFail = false;
    await client.imagePull('other:latest');
    await expect(client.imageInspect('other:latest')).resolves.toBeTruthy();
  });

  it('round-trips a tar archive through putArchive and getArchive', async () => {
    const { client } = await start();
    const created = await client.containerCreate('box-tar', { Image: 'aihub-sandbox:latest' });
    await client.containerStart(created.Id);

    const tar = packTarFile('hello.txt', 'hello sandbox');
    await client.putArchive(created.Id, '/mnt/data', tar);
    const downloaded = await client.getArchive(created.Id, '/mnt/data/hello.txt');
    expect(extractTarFile(downloaded, 'hello.txt').toString('utf8')).toBe('hello sandbox');
  });

  it('wraps a missing unix socket as an unreachable daemon', async () => {
    const client = new DockerEngineClient({ socketPath: '/tmp/aihub-no-such-docker.sock' });
    await expect(client.ping()).rejects.toThrow(/Docker daemon is unreachable/);
  });
});
