import debug from 'debug';

import { emailEnv } from '@/envs/email';
import { resolveServerRuntimeBranding } from '@/server/enterprise/services/branding';
import type { RuntimeBranding } from '@/types/platform/branding';

import { type EmailPayload, type EmailResponse, type EmailServiceImpl } from './impls';
import { createEmailServiceImpl, EmailImplType } from './impls';

const log = debug('lobe-email:branding');

export interface EmailBrandingContext {
  branding: RuntimeBranding;
  revision: string | null;
}

export interface EmailServiceOptions {
  onBrandedSend?: (context: EmailBrandingContext) => void;
  resolveBranding?: () => Promise<RuntimeBranding>;
}

const formatSender = (name: string, address: string): string =>
  `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}" <${address}>`;

/**
 * Email service class
 * Provides email sending functionality with multiple provider support
 */
export class EmailService {
  private emailImpl: EmailServiceImpl;
  private readonly onBrandedSend?: EmailServiceOptions['onBrandedSend'];
  private readonly resolveBranding: NonNullable<EmailServiceOptions['resolveBranding']>;

  constructor(implType?: EmailImplType, options: EmailServiceOptions = {}) {
    // Avoid client-side access to server env when executed in browser-like test environments
    const envImplType =
      typeof window === 'undefined'
        ? (emailEnv.EMAIL_SERVICE_PROVIDER as EmailImplType | undefined)
        : undefined;
    const resolvedImplType = implType ?? envImplType ?? EmailImplType.Nodemailer;

    this.emailImpl = createEmailServiceImpl(resolvedImplType);
    this.resolveBranding = options.resolveBranding ?? resolveServerRuntimeBranding;
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
    const branding = await this.resolveBranding();
    const context = { branding, revision: branding.publishedRevision };
    const payload = buildPayload(context);
    const defaultAddress =
      branding.emailFrom ??
      (emailEnv.EMAIL_SERVICE_PROVIDER === EmailImplType.Resend
        ? emailEnv.RESEND_FROM
        : (emailEnv.SMTP_FROM ?? emailEnv.SMTP_USER));
    const brandedPayload =
      payload.from || !defaultAddress
        ? payload
        : {
            ...payload,
            from: formatSender(branding.emailSenderName ?? branding.name, defaultAddress),
          };

    const response = await this.emailImpl.sendMail(brandedPayload);
    log('sent with Published branding revision=%s', context.revision ?? 'built-in');
    this.onBrandedSend?.(context);

    return response;
  }

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
