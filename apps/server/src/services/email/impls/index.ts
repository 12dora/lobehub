import { NodemailerImpl, type NodemailerInjectedConfig } from './nodemailer';
import { ResendImpl, type ResendInjectedConfig } from './resend';
import { type EmailServiceImpl } from './type';

/**
 * Available email service implementations
 */
export enum EmailImplType {
  Nodemailer = 'nodemailer',
  Resend = 'resend',
  // Future providers can be added here:
  // SendGrid = 'sendgrid',
}

/**
 * Create an email service implementation instance
 */
export const createEmailServiceImpl = (
  type: EmailImplType = EmailImplType.Nodemailer,
  config?: NodemailerInjectedConfig | ResendInjectedConfig,
): EmailServiceImpl => {
  switch (type) {
    case EmailImplType.Nodemailer: {
      return new NodemailerImpl(config as NodemailerInjectedConfig | undefined);
    }
    case EmailImplType.Resend: {
      return new ResendImpl(config as ResendInjectedConfig | undefined);
    }

    default: {
      return new NodemailerImpl(config as NodemailerInjectedConfig | undefined);
    }
  }
};

export type { EmailServiceImpl } from './type';
export type { EmailPayload, EmailResponse } from './type';
