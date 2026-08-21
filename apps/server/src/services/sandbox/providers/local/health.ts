import { DEFAULT_SANDBOX_IMAGE, SANDBOX_LABEL, SANDBOX_LABEL_VALUE } from './constants';
import { DockerEngineClient, isDockerNotFound, wrapDockerUnreachable } from './dockerEngineClient';

export interface LocalSandboxHealth {
  activeContainers: number;
  daemonReachable: boolean;
  imagePresent: boolean;
  lastError?: string;
}

export type LocalSandboxHealthOptions = {
  host?: string;
  image?: string;
  socketPath?: string;
};

export const checkLocalSandboxHealth = async (
  options: LocalSandboxHealthOptions = {},
): Promise<LocalSandboxHealth> => {
  const client = new DockerEngineClient({ host: options.host, socketPath: options.socketPath });
  const image = options.image || DEFAULT_SANDBOX_IMAGE;

  try {
    await client.ping();
  } catch (error) {
    return {
      activeContainers: 0,
      daemonReachable: false,
      imagePresent: false,
      lastError: wrapDockerUnreachable(error).message,
    };
  }

  let imagePresent = false;
  let lastError: string | undefined;

  try {
    await client.imageInspect(image);
    imagePresent = true;
  } catch (error) {
    if (!isDockerNotFound(error)) {
      lastError = (error as Error).message;
    }
  }

  let activeContainers = 0;
  try {
    const containers = await client.containerList({
      all: false,
      filters: { label: [`${SANDBOX_LABEL}=${SANDBOX_LABEL_VALUE}`] },
    });
    activeContainers = containers.length;
  } catch (error) {
    lastError = (error as Error).message;
  }

  return {
    activeContainers,
    daemonReachable: true,
    imagePresent,
    ...(lastError ? { lastError } : {}),
  };
};
