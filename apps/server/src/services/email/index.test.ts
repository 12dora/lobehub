import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerRuntimeBrandingSnapshot } from '@/server/enterprise/services/branding';

import { createEmailServiceImpl, EmailImplType } from './impls';
import { EmailService } from './index';

// Mock dependencies
const auditPersistenceMocks = vi.hoisted(() => ({
  append: vi.fn(),
  getServerDB: vi.fn(),
}));

vi.mock('./impls');
vi.mock('@/database/core/db-adaptor', () => ({
  getServerDB: auditPersistenceMocks.getServerDB,
}));
vi.mock('@/server/enterprise/services/platformAudit', () => ({
  PlatformAuditService: vi.fn().mockImplementation(() => ({
    append: auditPersistenceMocks.append,
  })),
}));

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
    auditPersistenceMocks.append.mockResolvedValue(undefined);
    auditPersistenceMocks.getServerDB.mockResolvedValue({});
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
    const createBrandingSnapshot = (emailFrom: string | null): ServerRuntimeBrandingSnapshot => {
      const publishedBranding = {
        defaultAgentDisplayName: 'AIHub AI',
        emailFrom,
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
        revision: '42',
        shortName: 'AIHub',
        supportUrl: null,
        termsUrl: null,
      };

      return {
        branding: { ...publishedBranding, publishedRevision: '42' },
        publicSnapshot: {
          branding: publishedBranding,
          brandingRevision: '42',
          configRevision: 'config-42',
          login: { workAccountEnabled: false },
          logoUrl: null,
          platformName: 'AIHub',
        },
      };
    };

    it('uses one exact Published revision for template, sender and durable audit', async () => {
      const onBrandedSend = vi.fn();
      const recordBrandingAudit = vi.fn();
      const snapshot = createBrandingSnapshot('mail@example.com');
      const resolveBrandingSnapshot = vi.fn().mockResolvedValue(snapshot);
      emailService = new EmailService(EmailImplType.Nodemailer, {
        onBrandedSend,
        recordBrandingAudit,
        resolveBrandingSnapshot,
      });
      mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'message-id' });

      const result = await emailService.sendBrandedMail(({ branding: captured, revision }) => ({
        subject: `${captured.name}:${revision}`,
        to: 'recipient@example.com',
      }));

      expect(resolveBrandingSnapshot).toHaveBeenCalledTimes(1);
      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith({
        from: '"AI \\"Hub\\"" <mail@example.com>',
        subject: 'AIHub:42',
        to: 'recipient@example.com',
      });
      expect(recordBrandingAudit).toHaveBeenCalledWith({
        messageId: 'message-id',
        result: 'success',
        revision: '42',
      });
      expect(Object.keys(recordBrandingAudit.mock.calls[0][0]).sort()).toEqual([
        'messageId',
        'result',
        'revision',
      ]);
      expect(onBrandedSend).toHaveBeenCalledWith({ branding: snapshot.branding, revision: '42' });
      expect(result).toEqual({ messageId: 'message-id' });
      expect(result).not.toHaveProperty('brandingRevision');
    });

    it.each([
      ['feature disabled', null],
      ['Published emailFrom is null', createBrandingSnapshot(null)],
    ])('preserves provider/env sender semantics when %s', async (_, snapshot) => {
      const resolvedSnapshot =
        snapshot ??
        ({
          branding: { ...createBrandingSnapshot(null).branding, publishedRevision: null },
          publicSnapshot: {
            branding: null,
            brandingRevision: null,
            configRevision: '0',
            login: { workAccountEnabled: false },
            logoUrl: null,
            platformName: null,
          },
        } satisfies ServerRuntimeBrandingSnapshot);
      emailService = new EmailService(EmailImplType.Nodemailer, {
        recordBrandingAudit: vi.fn(),
        resolveBrandingSnapshot: vi.fn().mockResolvedValue(resolvedSnapshot),
      });
      mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'message-id' });

      await emailService.sendBrandedMail(() => ({
        subject: 'Subject',
        to: 'recipient@example.com',
      }));

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith({
        subject: 'Subject',
        to: 'recipient@example.com',
      });
      expect(mockEmailImpl.sendMail.mock.calls[0][0]).not.toHaveProperty('from');
    });

    it('preserves an explicit caller sender instead of overriding its display name', async () => {
      emailService = new EmailService(EmailImplType.Nodemailer, {
        recordBrandingAudit: vi.fn(),
        resolveBrandingSnapshot: vi
          .fn()
          .mockResolvedValue(createBrandingSnapshot('brand@test.dev')),
      });
      mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'message-id' });

      await emailService.sendBrandedMail(() => ({
        from: '"SMTP Default" <smtp@test.dev>',
        subject: 'Subject',
        to: 'recipient@example.com',
      }));

      expect(mockEmailImpl.sendMail).toHaveBeenCalledWith({
        from: '"SMTP Default" <smtp@test.dev>',
        subject: 'Subject',
        to: 'recipient@example.com',
      });
    });

    it('audits a failed delivery without recipient/body and rethrows the original error', async () => {
      const recordBrandingAudit = vi.fn();
      const sendError = new Error('provider unavailable');
      emailService = new EmailService(EmailImplType.Nodemailer, {
        recordBrandingAudit,
        resolveBrandingSnapshot: vi.fn().mockResolvedValue(createBrandingSnapshot('mail@test.dev')),
      });
      mockEmailImpl.sendMail.mockRejectedValue(sendError);

      await expect(
        emailService.sendBrandedMail(() => ({
          html: '<p>private body</p>',
          subject: 'Private subject',
          to: 'recipient@example.com',
        })),
      ).rejects.toBe(sendError);
      expect(recordBrandingAudit).toHaveBeenCalledWith({ result: 'failure', revision: '42' });
      expect(JSON.stringify(recordBrandingAudit.mock.calls[0][0])).not.toContain('recipient');
      expect(JSON.stringify(recordBrandingAudit.mock.calls[0][0])).not.toContain('private');
    });

    it('persists the system audit with only revision and provider message id', async () => {
      emailService = new EmailService(EmailImplType.Nodemailer, {
        resolveBrandingSnapshot: vi.fn().mockResolvedValue(createBrandingSnapshot('mail@test.dev')),
      });
      mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'provider-message-id' });

      await emailService.sendBrandedMail(() => ({
        html: '<p>private body</p>',
        subject: 'Private subject',
        to: 'recipient@example.com',
      }));

      expect(auditPersistenceMocks.append).toHaveBeenCalledWith({
        action: 'system.email.send',
        actorUserId: null,
        afterDiff: {
          brandingRevision: '42',
          messageId: 'provider-message-id',
        },
        result: 'success',
        targetId: 'provider-message-id',
        targetType: 'email_delivery',
      });
      expect(JSON.stringify(auditPersistenceMocks.append.mock.calls[0][0])).not.toContain(
        'recipient',
      );
      expect(JSON.stringify(auditPersistenceMocks.append.mock.calls[0][0])).not.toContain(
        'private',
      );
    });

    it.each(['success', 'failure'] as const)(
      'does not change the %s delivery result when durable audit persistence fails',
      async (result) => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const sendError = new Error('send failed');
        emailService = new EmailService(EmailImplType.Nodemailer, {
          recordBrandingAudit: vi.fn().mockRejectedValue(new Error('audit failed')),
          resolveBrandingSnapshot: vi
            .fn()
            .mockResolvedValue(createBrandingSnapshot('mail@test.dev')),
        });
        if (result === 'success') {
          mockEmailImpl.sendMail.mockResolvedValue({ messageId: 'message-id' });
          await expect(
            emailService.sendBrandedMail(() => ({ subject: 'Subject', to: 'to@test.dev' })),
          ).resolves.toEqual({ messageId: 'message-id' });
        } else {
          mockEmailImpl.sendMail.mockRejectedValue(sendError);
          await expect(
            emailService.sendBrandedMail(() => ({ subject: 'Subject', to: 'to@test.dev' })),
          ).rejects.toBe(sendError);
        }
        expect(mockEmailImpl.sendMail).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith('[email-branding] audit append failed', {
          errorName: 'Error',
          result,
        });
        consoleError.mockRestore();
      },
    );
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
