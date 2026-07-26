'use client';

import type { ReactNode } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import type { ManagedResourceKind } from '@/const/platform/managedResources';

import { ManagedResourceNotice } from './ManagedResourceNotice';
import { ManagedResourceTransition } from './ManagedResourceTransition';
import { useManagedResource } from './useManagedResource';

export interface ManagedResourceBoundaryProps {
  children: ReactNode;
  resource: ManagedResourceKind;
}

export const ManagedResourceBoundary = ({ children, resource }: ManagedResourceBoundaryProps) => {
  const { error, loading, managed, refresh } = useManagedResource(resource);

  const state = error ? 'error' : loading ? 'loading' : managed ? 'managed' : 'content';
  const content = error ? (
    <AsyncError error={error} variant="page" onRetry={() => void refresh()} />
  ) : loading ? (
    <Loading debugId={`ManagedResourceBoundary > ${resource}`} />
  ) : managed ? (
    <ManagedResourceNotice resource={resource} />
  ) : (
    children
  );

  return <ManagedResourceTransition state={state}>{content}</ManagedResourceTransition>;
};
