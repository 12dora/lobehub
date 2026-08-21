'use client';

import type { ReactNode } from 'react';

import AsyncError from '@/components/AsyncError';
import Loading from '@/components/Loading/BrandTextLoading';
import DelayedFallback from '@/components/Loading/DelayedFallback';
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
    <DelayedFallback>
      <Loading debugId={`ManagedResourceBoundary > ${resource}`} variant={'inline'} />
    </DelayedFallback>
  ) : managed ? (
    <ManagedResourceNotice resource={resource} />
  ) : (
    children
  );

  return <ManagedResourceTransition state={state}>{content}</ManagedResourceTransition>;
};
