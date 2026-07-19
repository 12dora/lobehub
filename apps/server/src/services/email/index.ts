import debug from 'debug';

import { getServerDB } from '@/database/core/db-adaptor';
import { emailEnv } from '@/envs/email';
import {
  resolveServerRuntimeBrandingSnapshot,
  type ServerRuntimeBrandingSnapshot,
} from '@/server/enterprise/services/branding';
import { PlatformAuditService } from '@/server/enterprise/services/platformAudit';
import type { RuntimeBranding } from '@/types/platform/branding';

import { type EmailPayload, type EmailResponse, type EmailServiceImpl } from './impls';
import { createEmailServiceImpl, EmailImplType } from './impls';

const log = debug('lobe-email:branding');

export interface EmailBrandingContext {
  branding: RuntimeBranding;
  revision: string | null;
}

export interface EmailBrandingAuditEvent {
  messageId?: string;
  result: 'failure' | 'success';
  revision: string | null;
}

export interface EmailServiceOptions {
  onBrandedSend?: (context: EmailBrandingContext) => void;
  recordBrandingAudit?: (event: EmailBrandingAuditEvent) => Promise<void>;
  resolveBrandingSnapshot?: () => Promise<ServerRuntimeBrandingSnapshot>;
}

const formatSender = (name: string, address: string): string =>
  `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${address}>`;

const recordBrandingAudit = async (event: EmailBrandingAuditEvent): Promise<void> => {
  const db = await getServerDB();
  await new PlatformAuditService(db).append({
    action: 'system.email.send',
    actorUserId: null,
    afterDiff: {
      brandingRevision: event.revision,
      messageId: event.messageId ?? null,
    },
    result: event.result,
    targetId: event.messageId ?? null,
    targetType: 'email_delivery',
  });
};

/**
 * Email service class
 * Provides email sending functionality with multiple provider support
 */
export class EmailService {
  private emailImpl: EmailServiceImpl;
  private readonly onBrandedSend?: EmailServiceOptions['onBrandedSend'];
  private readonly recordBrandingAudit: NonNullable<EmailServiceOptions['recordBrandingAudit']>;
  private readonly resolveBrandingSnapshot: NonNullable<
    EmailServiceOptions['resolveBrandingSnapshot']
  >;

  constructor(implType?: EmailImplType, options: EmailServiceOptions = {}) {
    // Avoid client-side access to server env when executed in browser-like test environments
    const envImplType =
      typeof window === 'undefined'
        ? (emailEnv.EMAIL_SERVICE_PROVIDER as EmailImplType | undefined)
        : undefined;
    const resolvedImplType = implType ?? envImplType ?? EmailImplType.Nodemailer;

    this.emailImpl = createEmailServiceImpl(resolvedImplType);
    this.resolveBrandingSnapshot =
      options.resolveBrandingSnapshot ?? resolveServerRuntimeBrandingSnapshot;
    this.recordBrandingAudit = options.recordBrandingAudit ?? recordBrandingAudit;
    this.onBrandedSend = options.onBrandedSend;
  }

  /**
   * Send an email
   */
  async sendMail(payload: EmailPayload): Promise<EmailResponse> {
    return this.emailImpl.sendMail(payload);
  }

  /** Captures exactly one Published revision for both template content and sender identity. */
  async sendBrandedMail(
    buildPayload: (context: EmailBrandingContext) => EmailPayload,
  ): Promise<EmailResponse> {
    const { branding, publicSnapshot } = await this.resolveBrandingSnapshot();
    const context = { branding, revision: branding.publishedRevision };
    const publishedEmailFrom = publicSnapshot.branding?.emailFrom ?? null;

    try {
      const payload = buildPayload(context);
      const brandedPayload =
        payload.from || !publishedEmailFrom
          ? payload
          : {
              ...payload,
              from: formatSender(branding.emailSenderName ?? branding.name, publishedEmailFrom),
            };
      const response = await this.emailImpl.sendMail(brandedPayload);
      await this.recordBrandingAuditBestEffort({
        messageId: response.messageId,
        result: 'success',
        revision: context.revision,
      });
      log('sent with Published branding revision=%s', context.revision ?? 'built-in');
      this.notifyBrandedSendBestEffort(context);

      return response;
    } catch (error) {
      await this.recordBrandingAuditBestEffort({
        result: 'failure',
        revision: context.revision,
      });
      throw error;
    }
  }

  private notifyBrandedSendBestEffort = (context: EmailBrandingContext): void => {
    try {
      this.onBrandedSend?.(context);
    } catch (error) {
      console.error('[email-branding] observer failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  };

  private recordBrandingAuditBestEffort = async (event: EmailBrandingAuditEvent): Promise<void> => {
    try {
      await this.recordBrandingAudit(event);
    } catch (error) {
      console.error('[email-branding] audit append failed', {
        errorName: error instanceof Error ? error.name : 'unknown',
        result: event.result,
      });
    }
  };

  /**
   * Verify the email service configuration
   * Note: Only available for Nodemailer implementation
   */
  async verify(): Promise<boolean> {
    // Check if the implementation has a verify method
    if ('verify' in this.emailImpl && typeof this.emailImpl.verify === 'function') {
      return this.emailImpl.verify();
    }

    // For implementations without verify, assume it's valid
    return true;
  }
}

// Export types
export type { EmailPayload, EmailResponse } from './impls';
export { EmailImplType } from './impls';
