import { Request, Response } from 'express';
import { createHash, randomUUID } from 'crypto';
import { EvolutionService } from '../services/evolution.service';
import { AuthedRequest } from '../middleware/auth.middleware';
import { resolveSpintax, formatPhoneNumber, delay } from '../services/utils.service';

interface MessageBase {
  type: string;
}

interface TextMessage extends MessageBase {
  type: 'text';
  content: string;
}

interface ImageMessage extends MessageBase {
  type: 'image';
  url?: string;
  base64?: string;
  caption?: string;
}

interface VideoMessage extends MessageBase {
  type: 'video';
  url?: string;
  base64?: string;
  caption?: string;
}

interface AudioMessage extends MessageBase {
  type: 'audio' | 'voice' | 'ptt';
  url?: string;
  base64?: string;
  ptt?: boolean;
}

interface DocumentMessage extends MessageBase {
  type: 'document';
  url?: string;
  base64?: string;
  filename?: string;
  caption?: string;
}

interface LocationMessage extends MessageBase {
  type: 'location';
  latitude: number;
  longitude: number;
  description?: string;
}

interface ContactMessage extends MessageBase {
  type: 'contact';
  contactName: string;
  contactNumber: string;
}

interface CatalogMessage extends MessageBase {
  type: 'catalog';
  images: Array<{ imageUrl?: string; imageBase64?: string }>;
  caption?: string;
  captionMode?: 'text_before' | 'all' | 'first' | 'none';
}

type Message =
  | TextMessage
  | ImageMessage
  | VideoMessage
  | AudioMessage
  | DocumentMessage
  | LocationMessage
  | ContactMessage
  | CatalogMessage;

interface SequenceRequest {
  to: string;
  messages: Message[];
  delayMs?: number;
}

interface MessageResult {
  index: number;
  type: string;
  status: 'queued' | 'sending' | 'sent' | 'failed' | 'unknown';
  messageId?: string;
  error?: string;
}

interface SequenceJob {
  id: string;
  instance?: string;
  phone: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors';
  results: MessageResult[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  messages: Message[];
  delayMs: number;
  key?: string;
}

interface IdempotencyRecord {
  sequenceId: string;
  fingerprint: string;
  expiresAt: number;
}

/**
 * Which profile this sequence sends as. Both fields come from the auth
 * middleware and must be forwarded to every EvolutionService call.
 *
 * This replaced a bare `apiToken: string` that was threaded through each
 * helper. Two problems with that:
 *
 *   1. instanceName was never passed, so EvolutionService fell back to
 *      DEFAULT_INSTANCE_NAME. The request URL therefore named the default
 *      profile while carrying another profile's token, which Evolution
 *      rejects - sequences could only ever work for the default instance.
 *
 *   2. sendAudio takes `ptt` before `instanceName`, so the 4-argument call
 *      `sendAudio(phone, url, undefined, apiToken)` put the token in the
 *      instanceName slot and sent to an instance named after the token.
 *
 * Passing an object instead of positional extras makes that class of mistake
 * hard to repeat.
 */
interface Target {
  instance?: string;
  key?: string;
}

export class SequenceController {
  private readonly jobs = new Map<string, SequenceJob>();
  private readonly idempotencyKeys = new Map<string, IdempotencyRecord>();

  constructor(private evolutionService: EvolutionService) {}

  async sendSequence(req: Request, res: Response) {
    try {
      const { to, messages, delayMs = 3000 }: SequenceRequest = req.body;

      const areq = req as AuthedRequest;
      const target: Target = { instance: areq.instanceName, key: areq.instanceKey };

      // Validation
      if (!to) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: to',
        });
      }

      if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Missing or empty "messages" array',
        });
      }

      if (messages.length > 20) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 20 messages per sequence allowed',
        });
      }

      // Format phone
      const phone = formatPhoneNumber(to);
      const chatId = `${phone}@s.whatsapp.net`;
      const actualDelay = Math.max(1000, Math.min(delayMs, 15000));
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ phone, messages, delayMs: actualDelay, instance: target.instance }))
        .digest('hex');
      const suppliedKey = req.get('Idempotency-Key') || req.body.idempotencyKey;
      const idempotencyKey = typeof suppliedKey === 'string' && suppliedKey.trim() ? suppliedKey.trim() : undefined;

      this.removeExpiredRecords();
      if (idempotencyKey) {
        const recordKey = `${target.instance ?? 'default'}:${idempotencyKey}`;
        const existing = this.idempotencyKeys.get(recordKey);
        if (existing) {
          if (existing.fingerprint !== fingerprint) {
            return res.status(409).json({
              success: false,
              error: 'Idempotency-Key was already used with a different sequence',
            });
          }
          const existingJob = this.jobs.get(existing.sequenceId);
          if (existingJob) return res.status(202).json(this.jobResponse(existingJob, chatId, true));
          this.idempotencyKeys.delete(recordKey);
        }
      }

      const now = new Date().toISOString();
      const sequenceId = randomUUID();
      const job: SequenceJob = {
        id: sequenceId,
        instance: target.instance,
        phone,
        status: 'queued',
        results: messages.map((message, index) => ({
          index,
          type: (message.type || 'text').toLowerCase(),
          status: 'queued',
        })),
        createdAt: now,
        updatedAt: now,
        messages,
        delayMs: actualDelay,
        key: target.key,
      };

      this.jobs.set(sequenceId, job);
      if (idempotencyKey) {
        this.idempotencyKeys.set(`${target.instance ?? 'default'}:${idempotencyKey}`, {
          sequenceId,
          fingerprint,
          expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        });
      }

      // A timeout from the caller must not cause a replay of a long-running sequence.
      void this.processSequence(job).catch((error) => {
        console.error(`[sendSequence] Background job ${sequenceId} failed:`, error);
      });

      return res.status(202).json(this.jobResponse(job, chatId));
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Internal server error',
      });
    }
  }

  getSequenceStatus(req: Request, res: Response) {
    const areq = req as AuthedRequest;
    const job = this.jobs.get(req.params.sequenceId);
    if (!job || job.instance !== areq.instanceName) {
      return res.status(404).json({ success: false, error: 'Sequence not found' });
    }

    return res.json(this.jobResponse(job, `${job.phone}@s.whatsapp.net`));
  }

  private async processSequence(job: SequenceJob) {
    job.status = 'running';
    this.touch(job);

    try {
      const available = await this.evolutionService.isInstanceAvailable(job.instance, job.key);
      if (!available) {
        for (const result of job.results) {
          result.status = 'failed';
          result.error = `WhatsApp client not available for instance "${job.instance ?? 'default'}"`;
        }
        return;
      }

      const target: Target = { instance: job.instance, key: job.key };
      for (let i = 0; i < job.messages.length; i++) {
        const msg = job.messages[i];
        const result = job.results[i];
        result.status = 'sending';
        this.touch(job);

        try {
          const response = await this.sendMessage(job.phone, msg, target);
          result.status = 'sent';
          result.messageId = response?.key?.id || 'unknown';
        } catch (error: any) {
          const message = error?.message || 'Unknown error';
          const isTimeout = error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || /timeout/i.test(message);
          result.status = isTimeout ? 'unknown' : 'failed';
          result.error = message;
        }

        this.touch(job);
        if (i < job.messages.length - 1) await delay(job.delayMs);
      }
    } catch (error: any) {
      const message = error?.message || 'Sequence processing failed';
      for (const result of job.results) {
        if (result.status === 'queued' || result.status === 'sending') {
          result.status = 'failed';
          result.error = message;
        }
      }
    } finally {
      job.status = job.results.some((result) => result.status === 'failed' || result.status === 'unknown')
        ? 'completed_with_errors'
        : 'completed';
      job.completedAt = new Date().toISOString();
      job.key = undefined;
      this.touch(job);
    }
  }

  private async sendMessage(phone: string, msg: Message, target: Target): Promise<any> {
    switch ((msg.type || 'text').toLowerCase()) {
      case 'text':
        return this.sendTextMessage(phone, msg as TextMessage, target);
      case 'image':
        return this.sendImageMessage(phone, msg as ImageMessage, target);
      case 'video':
        return this.sendVideoMessage(phone, msg as VideoMessage, target);
      case 'audio':
      case 'voice':
      case 'ptt':
        return this.sendAudioMessage(phone, msg as AudioMessage, target);
      case 'document':
        return this.sendDocumentMessage(phone, msg as DocumentMessage, target);
      case 'location':
        return this.sendLocationMessage(phone, msg as LocationMessage, target);
      case 'contact':
        return this.sendContactMessage(phone, msg as ContactMessage, target);
      case 'catalog':
        return this.sendCatalogMessage(phone, msg as CatalogMessage, target);
      default:
        throw new Error(`Unknown message type: ${msg.type}`);
    }
  }

  private jobResponse(job: SequenceJob, chatId: string, duplicate = false) {
    const sent = job.results.filter((result) => result.status === 'sent').length;
    const failed = job.results.filter((result) => result.status === 'failed').length;
    const unknown = job.results.filter((result) => result.status === 'unknown').length;
    return {
      success: job.status === 'queued' || job.status === 'running' || job.status === 'completed',
      status: job.status,
      sequenceId: job.id,
      duplicate,
      sent,
      failed,
      unknown,
      total: job.results.length,
      chatId,
      instance: job.instance,
      statusUrl: `/api/v1/messages/send-sequence/${job.id}`,
      results: job.results.map(({ index, type, status, messageId, error }) => ({
        index,
        type,
        status,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(error ? { error } : {}),
      })),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    };
  }

  private touch(job: SequenceJob) {
    job.updatedAt = new Date().toISOString();
  }

  private removeExpiredRecords() {
    const now = Date.now();
    for (const [key, record] of this.idempotencyKeys) {
      if (record.expiresAt <= now) this.idempotencyKeys.delete(key);
    }
    for (const [id, job] of this.jobs) {
      if (job.completedAt && now - Date.parse(job.completedAt) > 24 * 60 * 60 * 1000) this.jobs.delete(id);
    }
  }

  private async sendTextMessage(phone: string, msg: TextMessage, t: Target) {
    if (!msg.content) {
      throw new Error('Text message requires "content" field');
    }

    const content = resolveSpintax(msg.content);
    return await this.evolutionService.sendText(phone, content, t.instance, t.key);
  }

  private async sendImageMessage(phone: string, msg: ImageMessage, t: Target) {
    if (!msg.url && !msg.base64) {
      throw new Error('Image requires "url" or "base64" field');
    }

    if (msg.base64) {
      return await this.evolutionService.sendMediaBase64(phone, msg.base64, 'image', msg.caption, t.instance, t.key);
    } else {
      return await this.evolutionService.sendImage(phone, msg.url!, msg.caption, t.instance, t.key);
    }
  }

  private async sendVideoMessage(phone: string, msg: VideoMessage, t: Target) {
    if (!msg.url && !msg.base64) {
      throw new Error('Video requires "url" or "base64" field');
    }

    if (msg.base64) {
      return await this.evolutionService.sendMediaBase64(phone, msg.base64, 'video', msg.caption, t.instance, t.key);
    } else {
      return await this.evolutionService.sendVideo(phone, msg.url!, msg.caption, t.instance, t.key);
    }
  }

  private async sendAudioMessage(phone: string, msg: AudioMessage, t: Target) {
    if (!msg.url && !msg.base64) {
      throw new Error('Audio requires "url" or "base64" field');
    }

    const isPtt = msg.type === 'voice' || msg.type === 'ptt' || msg.ptt !== false;

    if (msg.base64) {
      // For base64 audio, use sendMediaBase64
      return await this.evolutionService.sendMediaBase64(phone, msg.base64, 'audio', undefined, t.instance, t.key);
    } else {
      // NOTE the argument order: (phone, audioUrl, ptt, instanceName, apiKey).
      // isPtt was previously computed and then dropped on the floor here.
      return await this.evolutionService.sendAudio(phone, msg.url!, isPtt, t.instance, t.key);
    }
  }

  private async sendDocumentMessage(phone: string, msg: DocumentMessage, t: Target) {
    if (!msg.url && !msg.base64) {
      throw new Error('Document requires "url" or "base64" field');
    }

    if (msg.base64) {
      return await this.evolutionService.sendMediaBase64(
        phone,
        msg.base64,
        'document',
        msg.caption,
        t.instance,
        t.key,
      );
    } else {
      return await this.evolutionService.sendDocument(phone, msg.url!, msg.filename, t.instance, t.key);
    }
  }

  private async sendLocationMessage(phone: string, msg: LocationMessage, t: Target) {
    if (msg.latitude === undefined || msg.longitude === undefined) {
      throw new Error('Location requires "latitude" and "longitude"');
    }

    return await this.evolutionService.sendLocation(
      phone,
      msg.latitude,
      msg.longitude,
      msg.description,
      msg.description,
      t.instance,
      t.key,
    );
  }

  private async sendContactMessage(phone: string, msg: ContactMessage, t: Target) {
    if (!msg.contactName || !msg.contactNumber) {
      throw new Error('Contact requires "contactName" and "contactNumber"');
    }

    return await this.evolutionService.sendContact(phone, msg.contactNumber, msg.contactName, t.instance, t.key);
  }

  private async sendCatalogMessage(phone: string, msg: CatalogMessage, t: Target) {
    if (!msg.images || msg.images.length === 0) {
      throw new Error('Catalog requires "images" array');
    }

    if (msg.images.length > 30) {
      throw new Error('Catalog max 30 images');
    }

    const captionMode = msg.captionMode || 'text_before';

    // Send caption as text before if needed
    if (captionMode === 'text_before' && msg.caption) {
      await this.evolutionService.sendText(phone, msg.caption, t.instance, t.key);
      await delay(1000);
    }

    // Send images
    for (let i = 0; i < msg.images.length; i++) {
      const img = msg.images[i];
      let caption = '';

      if (captionMode === 'all') {
        caption = msg.caption || '';
      } else if (captionMode === 'first' && i === 0) {
        caption = msg.caption || '';
      }

      if (img.imageUrl) {
        await this.evolutionService.sendImage(phone, img.imageUrl, caption, t.instance, t.key);
      } else if (img.imageBase64) {
        await this.evolutionService.sendMediaBase64(phone, img.imageBase64, 'image', caption, t.instance, t.key);
      }

      // Small delay between catalog images
      if (i < msg.images.length - 1) {
        await delay(500);
      }
    }

    return { success: true };
  }
}
