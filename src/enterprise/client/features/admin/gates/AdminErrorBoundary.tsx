'use client';

import { FluentEmoji } from '@lobehub/ui';
import { Button } from '@lobehub/ui/base-ui';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { adminShellStyles } from '../layout/style';

interface AdminErrorBoundaryProps {
  children: ReactNode;
}

interface AdminErrorBoundaryState {
  error: Error | null;
}

/**
 * Scoped error boundary for the admin tree (does not take down the main SPA).
 */
export class AdminErrorBoundary extends Component<
  AdminErrorBoundaryProps,
  AdminErrorBoundaryState
> {
  state: AdminErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): AdminErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Avoid logging secrets; message only for local diagnostics.
    console.error('[admin] render error', error.message, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <AdminErrorFallback
          onRetry={() => {
            this.setState({ error: null });
          }}
        />
      );
    }
    return this.props.children;
  }
}

const AdminErrorFallback = ({ onRetry }: { onRetry: () => void }) => {
  const { t } = useTranslation('admin');
  const navigate = useNavigate();

  return (
    <div className={adminShellStyles.stateCenter}>
      <FluentEmoji emoji="💥" size={56} />
      <h2 style={{ fontWeight: 700, margin: 0 }}>{t('error.boundary.title')}</h2>
      <p style={{ maxWidth: 420, margin: 0 }}>{t('error.boundary.desc')}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button type="primary" onClick={onRetry}>
          {t('error.boundary.retry')}
        </Button>
        <Button onClick={() => navigate('/')}>{t('page.backHome')}</Button>
      </div>
    </div>
  );
};

export default AdminErrorBoundary;
