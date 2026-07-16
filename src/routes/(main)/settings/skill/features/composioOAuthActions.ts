import type { ComposioAppType } from '@lobechat/const';

import type { ComposioServer } from '@/store/tool/slices/composioStore';

export const createPersonalComposioConnection = (params: {
  createConnection: (input: {
    appSlug: string;
    identifier: string;
    label: string;
  }) => Promise<ComposioServer | undefined>;
  serverType: ComposioAppType;
}) =>
  params.createConnection({
    appSlug: params.serverType.appSlug,
    identifier: params.serverType.identifier,
    label: params.serverType.label,
  });

export const reauthorizePersonalComposioConnection = (params: {
  identifier: string;
  reauthorizeConnection: (identifier: string) => Promise<ComposioServer | undefined>;
}) => params.reauthorizeConnection(params.identifier);
