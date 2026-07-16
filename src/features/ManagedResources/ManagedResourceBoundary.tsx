'use client';

import type { ReactNode } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import type { ManagedResourceKind } from '@/const/platform/managedResources';

import { ManagedResourceNotice } from './ManagedResourceNotice';
import { useManagedResource } from './useManagedResource';

export interface ManagedResourceBoundaryProps {
  children: ReactNode;
  resource: ManagedResourceKind;
}

export const ManagedResourceBoundary = ({ children, resource }: ManagedResourceBoundaryProps) => {
  const { error, loading, managed, refresh } = useManagedResource(resource);

  if (error) return <AsyncError error={error} variant="page" onRetry={() => void refresh()} />;
  if (loading) return <Loading debugId={`ManagedResourceBoundary > ${resource}`} />;
  if (managed) return <ManagedResourceNotice resource={resource} />;
  return children;
};
