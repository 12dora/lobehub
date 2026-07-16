'use client';

import type { ComponentType, ReactNode } from 'react';

import { ManagedResourceBoundary } from './ManagedResourceBoundary';

interface ManagedAgentConfigurationBoundaryProps {
  boundary?: ComponentType<{ children: ReactNode; resource: 'agents' }>;
  children: ReactNode;
}

export const ManagedAgentConfigurationBoundary = ({
  boundary: Boundary = ManagedResourceBoundary,
  children,
}: ManagedAgentConfigurationBoundaryProps) => <Boundary resource="agents">{children}</Boundary>;
