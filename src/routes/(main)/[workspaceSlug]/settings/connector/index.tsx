'use client';

import { ManagedConnectorSettings } from '@/features/PlatformConnectorAuthorization';
import { ToolSettings } from '@/routes/(main)/settings/skill';

const WorkspaceConnectorSetting = () => (
  <ManagedConnectorSettings fallback={<ToolSettings viewMode="connector" />} />
);

WorkspaceConnectorSetting.displayName = 'WorkspaceConnectorSetting';

export default WorkspaceConnectorSetting;
