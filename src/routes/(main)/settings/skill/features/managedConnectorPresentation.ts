export type ConnectorSection =
  'builtinTools' | 'communityConnectors' | 'communityTools' | 'customConnectors';

/** Managed Connector UI preserves only per-user OAuth binding surfaces. */
export const isConnectorSectionVisible = (section: ConnectorSection, managed: boolean): boolean =>
  !managed || section === 'communityConnectors';
