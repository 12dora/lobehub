import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEmailServiceImpl, EmailImplType } from './impls';
import { EmailService } from './index';

// Mock dependencies
vi.mock('./impls');

describe('EmailService', () => {
  let emailService: EmailService;
  let mockEmailImpl: ReturnType<typeof createMockEmailImpl>;

  function createMockEmailImpl() {
    return {
      sendMail: vi.fn(),
      verify: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockEmailImpl = createMockEmailImpl();
    vi.mocked(createEmailServiceImpl).mockReturnValue(mockEmailImpl as any);
    emailService = new EmailService();
  });

  describe('constructor', () => {
    it('should create instance with default email implementation', () => {
      expect(createEmailServiceImpl).toHaveBeenCalledWith(EmailImplType.Nodemailer);
    });

    it('should create instance with specified implementation type', () => {
      emailService = new EmailService(EmailImplType.Nodemailer);
      expect(createEmailServiceImpl).toHaveBeenCalledWith(EmailImplType.Nodemailer);
    });
  });

  describe('sendMail', () => {
    it('should call emailImpl.sendMail with correct payload', async () => {
      const mockResponse = {
        messageId: 'test-message-id',
        previewUrl: 'https://ethereal.email/message/xxx',
      };
      mockEmailImpl.sendMail.mockResolvedValue(mockResponse);

      const payload = {
        from: 'sender@example.com',
        html: '<p>Hello world</p>',
        subject: 'Test Email',
        text: 'Hello world',
        to: 'recipient@example.com',
      };

      const result = await emailService.sendMail(payload);

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith(payload);
      expect(result).toBe(mockResponse);
    });

    it('should support multiple recipients', async () => {
      const mockResponse = {
        messageId: 'test-message-id',
      };
      mockEmailImpl.sendMail.mockResolvedValue(mockResponse);

      const payload = {
        from: 'sender@example.com',
        subject: 'Test Email',
        text: 'Hello world',
        to: ['recipient1@example.com', 'recipient2@example.com'],
      };

      await emailService.sendMail(payload);

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith(payload);
    });

    it('should support attachments', async () => {
      const mockResponse = {
        messageId: 'test-message-id',
      };
      mockEmailImpl.sendMail.mockResolvedValue(mockResponse);

      const payload = {
        attachments: [
          {
            content: Buffer.from('test content'),
            filename: 'test.txt',
          },
        ],
        from: 'sender@example.com',
        subject: 'Test Email',
        text: 'Hello world',
        to: 'recipient@example.com',
      };

      await emailService.sendMail(payload);

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith(payload);
    });

    it('should support reply-to address', async () => {
      const mockResponse = {
        messageId: 'test-message-id',
      };
      mockEmailImpl.sendMail.mockResolvedValue(mockResponse);

      const payload = {
        from: 'noreply@example.com',
        replyTo: 'support@example.com',
        subject: 'Test Email',
        text: 'Hello world',
        to: 'recipient@example.com',
      };

      await emailService.sendMail(payload);

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith(payload);
    });
  });

  describe('sendBrandedMail', () => {
    it('uses one exact revision for template, sender and observability', async () => {
      const onBrandedSend = vi.fn();
      const branding = {
        defaultAgentDisplayName: 'AIHub AI',
        emailFrom: 'mail@example.com',
        emailSenderName: 'AI "Hub"',
        faviconUrl: null,
        homeUrl: null,
        iconUrl: null,
        legalName: null,
        logoUrl: null,
        name: 'AIHub',
        ogImageUrl: null,
        pageTitleTemplate: '%s · AIHub',
        privacyUrl: null,
        publishedRevision: '42',
        shortName: 'AIHub',
        supportUrl: null,
        termsUrl: null,
      };
      const resolveBranding = vi.fn().mockResolvedValue(branding);
      emailService = new EmailService(EmailImplType.Nodemailer, {
        onBrandedSend,
        resolveBranding,
      });
      mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'message-id' });

      const result = await emailService.sendBrandedMail(({ branding: captured, revision }) => ({
        subject: `${captured.name}:${revision}`,
        to: 'recipient@example.com',
      }));

      expect(resolveBranding).toHaveBeenCalledTimes(1);
      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith({
        from: '"AI \\"Hub\\"" <mail@example.com>',
        subject: 'AIHub:42',
        to: 'recipient@example.com',
      });
      expect(onBrandedSend).toHaveBeenCalledWith({ branding, revision: '42' });
      expect(result).toEqual({ messageId: 'message-id' });
      expect(result).not.toHaveProperty('brandingRevision');
    });
  });

  describe('verify', () => {
    it('should call emailImpl.verify if available', async () => {
      mockEmailImpl.verify.mockResolvedValue(true);

      const result = await emailService.verify();

      expect(mockEmailImpl.verify).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should return true if verify method is not available', async () => {
      const mockImplWithoutVerify = {
        sendMail: vi.fn(),
      };
      vi.mocked(createEmailServiceImpl).mockReturnValue(mockImplWithoutVerify as any);
      emailService = new EmailService();

      const result = await emailService.verify();

      expect(result).toBe(true);
    });
  });
});
