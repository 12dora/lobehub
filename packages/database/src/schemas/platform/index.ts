/**
 * Platform (enterprise) database schemas — Migration 0 empty shells + M01 core tables.
 *
 * M01 core: revisions / audit logs / jobs
 * Later modules own business population of the remaining tables.
 */
export * from './adminMutationRate';
export * from './agents';
export * from './ai';
export * from './auditAdmin';
export * from './auditLogs';
export * from './branding';
export * from './common';
export * from './connectorGovernance';
export * from './connectors';
export * from './credentials';
export * from './easyauth';
export * from './identity';
export * from './instances';
export * from './jobs';
export * from './managedPolicy';
export * from './revisions';
export * from './settings';
export * from './skills';
