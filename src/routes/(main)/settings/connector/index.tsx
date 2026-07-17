'use client';

import { ManagedConnectorSettings } from '@/features/PlatformConnectorAuthorization';
import { ToolSettings } from '@/routes/(main)/settings/skill';

const Page = () => (
  <ManagedConnectorSettings fallback={<ToolSettings managed={false} viewMode="connector" />} />
);

Page.displayName = 'ConnectorSettings';

export default Page;
