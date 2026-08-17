import { TRPCError } from '@trpc/server';
import debug from 'debug';
import { type Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';

import { emailEnv } from '@/envs/email';

import { type EmailPayload, type EmailResponse, type EmailServiceImpl } from '../type';
import { type NodemailerConfig } from './type';

const log = debug('lobe-email:Nodemailer');

/**
 * Nodemailer implementation of the email service
 */
export interface NodemailerInjectedConfig {
  from?: string;
  host?: string;
  pass: string;
  port?: number;
  secure?: boolean;
  user: string;
}

export class NodemailerImpl implements EmailServiceImpl {
  private readonly fromFallback: string;
  private transporter: Transporter;

  constructor(config?: NodemailerInjectedConfig) {
    const user = config?.user ?? emailEnv.SMTP_USER;
    const pass = config?.pass ?? emailEnv.SMTP_PASS;
    log(
      config
        ? 'Initializing Nodemailer from injected config'
        : 'Initializing Nodemailer from environment variables',
    );

    if (!user || !pass) {
      throw new Error(
        'SMTP_USER and SMTP_PASS environment variables are required to use email service. Please configure SMTP settings in your .env file.',
      );
    }

    this.fromFallback = config?.from ?? emailEnv.SMTP_FROM ?? user;

    // Note: Use || to handle empty string from Dockerfile defaults
    const transportConfig: NodemailerConfig = {
      auth: {
        pass,
        user,
      },
      host: (config?.host ?? emailEnv.SMTP_HOST) || 'localhost',
      port: (config?.port ?? emailEnv.SMTP_PORT) || 587,
      secure: (config?.secure ?? emailEnv.SMTP_SECURE) || false,
    };

    try {
      this.transporter = nodemailer.createTransport(transportConfig);
      log('Nodemailer transporter created successfully');
    } catch (error) {
      log.extend('error')('Failed to create Nodemailer transporter: %o', error);
      throw new TRPCError({
        cause: error,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to initialize Nodemailer transport',
      });
    }
  }

  async sendMail(payload: EmailPayload): Promise<EmailResponse> {
    // Use SMTP_FROM as default sender, fallback to SMTP_USER for backward compatibility
    const from = payload.from || this.fromFallback;

    log('Sending email with payload: %o', {
      from,
      subject: payload.subject,
      to: payload.to,
    });

    try {
      const info = await this.transporter.sendMail({
        attachments: payload.attachments,
        from,
        html: payload.html,
        replyTo: payload.replyTo,
        subject: payload.subject,
        text: payload.text,
        to: payload.to,
      });

      log('Email sent successfully with message ID: %s', info.messageId);

      const previewUrl = nodemailer.getTestMessageUrl(info);

      return {
        messageId: info.messageId,
        previewUrl: previewUrl || undefined,
      };
    } catch (error) {
      log.extend('error')('Failed to send email: %o', error);
      throw new TRPCError({
        cause: error,
        code: 'SERVICE_UNAVAILABLE',
        message: `Failed to send email: ${(error as Error).message}`,
      });
    }
  }

  /**
   * Verify the SMTP connection configuration
   */
  async verify(): Promise<boolean> {
    try {
      log('Verifying SMTP connection...');
      await this.transporter.verify();
      log('SMTP connection verified successfully');
      return true;
    } catch (error) {
      log.extend('error')('SMTP verification failed: %o', error);
      throw new TRPCError({
        cause: error,
        code: 'SERVICE_UNAVAILABLE',
        message: 'Failed to verify SMTP connection',
      });
    }
  }
}
