import { Request, Response } from 'express';
import { WebhookService } from '../services/webhook.service';

export class WebhookController {
  constructor(private webhookService: WebhookService) {}

  /**
   * Register webhook URL
   * POST /api/webhook/register
   * POST /api/webhook/register/:instanceId
   */
  async registerWebhook(req: Request, res: Response) {
    try {
      // Both filters default to true: an older client that does not send these
      // fields must not silently start dropping group or own messages.
      const { url, enabled = true, groupMessages = true, fromMeMessages = true } = req.body;
      const instanceId = req.params.instanceId || (req as any).deviceUuid || req.body.instanceId || 'default';

      if (!url) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: url',
        });
      }

      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL format',
        });
      }

      // Await it: this now writes to Postgres. Fire-and-forget would return 200
      // before the row was durable.
      const storedAs = await this.webhookService.registerWebhook(
        instanceId,
        url,
        enabled,
        groupMessages !== false,
        fromMeMessages !== false,
      );

      return res.json({
        success: true,
        message: 'Webhook registered successfully',
        instanceId,
        storedAs,
        url,
        enabled,
        groupMessages: groupMessages !== false,
        fromMeMessages: fromMeMessages !== false,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to register webhook',
      });
    }
  }

  /**
   * Get webhook config
   * GET /api/webhook/config
   * GET /api/webhook/config/:instanceId
   *
   * Returns the n8n URL (stored in Backend), plus events from Evolution API.
   * This is called by Manager UI to display the webhook settings.
   */
  async getWebhookConfig(req: Request, res: Response) {
    try {
      const instanceId = req.params.instanceId || (req as any).deviceUuid || req.query.instanceId || 'default';
      const config = this.webhookService.getWebhook(instanceId as string);

      if (!config) {
        return res.status(404).json({
          success: false,
          error: 'No webhook configured for this instance',
          instanceId,
        });
      }

      // Try to fetch events from Evolution API
      let events: string[] = ['MESSAGES_UPSERT'];
      let webhookBase64 = false;
      let webhookByEvents = false;

      try {
        const evolutionApiUrl = process.env.EVOLUTION_API_URL || 'http://localhost:2345';
        const evolutionApiKey = process.env.EVOLUTION_API_KEY || '';

        const axios = await import('axios');
        const evolutionResponse = await axios.default.get(
          `${evolutionApiUrl}/webhook/find/${encodeURIComponent(instanceId as string)}`,
          {
            headers: {
              'apikey': evolutionApiKey,
            },
            timeout: 5000,
          }
        );

        if (evolutionResponse.data) {
          events = evolutionResponse.data.events || events;
          webhookBase64 = evolutionResponse.data.webhookBase64 || false;
          webhookByEvents = evolutionResponse.data.webhookByEvents || false;
        }
      } catch (error: any) {
        console.warn('[Webhook Config] Could not fetch events from Evolution API:', error.message);
      }

      return res.json({
        success: true,
        instanceId,
        url: config.url, // n8n URL from Backend
        enabled: config.enabled,
        events,
        webhookBase64,
        webhookByEvents,
        // Both live in Backend, not Evolution: the filters are applied here, on
        // the hop to n8n. `!== false` so a row predating either column reads as
        // on, which is what those rows were actually doing.
        groupMessages: config.groupMessages !== false,
        fromMeMessages: config.fromMeMessages !== false,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get webhook config',
      });
    }
  }

  /**
   * Receive incoming message from Evolution API
   * POST /api/webhook/incoming
   * OR
   * POST /api/webhook/incoming/:instanceId
   */
  async handleIncoming(req: Request, res: Response) {
    try {
      const rawPayload = req.body;

      // Extract the actual message data from Evolution wrapper
      // Evolution sends: { event, instance, data: { key, message, ... } }
      // We need just the data part
      const evolutionMessage = rawPayload.data || rawPayload;

      // Try to get instance ID from multiple sources
      const instanceId =
        req.params.instanceId ||              // From URL param
        (req as any).deviceUuid ||
        req.headers['x-device-uuid'] ||
        rawPayload.instance ||                // From Evolution payload
        rawPayload.data?.instanceId ||
        req.body.uuid ||
        'default';

      console.log(`[Webhook] Received message for instance: ${instanceId}`);

      // Transform Evolution message to WhatsDeveloper format
      const payload = this.webhookService.transformMessage(evolutionMessage, instanceId as string);

      // Send to registered webhook for this instance. sendWebhook returns a
      // reason so a deliberately dropped group message is not reported as a
      // missing configuration.
      const result = await this.webhookService.sendWebhook(instanceId as string, payload);

      // A filtered message is a success from Evolution's point of view: we
      // received it and decided not to forward. Returning an error here would
      // make Evolution retry a message we never intend to deliver.
      const FILTERED: Record<string, { message: string; skipped: string }> = {
        'group-filtered': {
          message: 'Group message skipped (group messages disabled for this instance)',
          skipped: 'group-messages-disabled',
        },
        'from-me-filtered': {
          message: 'Own message skipped (fromMe messages disabled for this instance)',
          skipped: 'from-me-messages-disabled',
        },
      };

      const filtered = result.reason ? FILTERED[result.reason] : undefined;
      if (!result.sent && filtered) {
        return res.json({
          success: true,
          message: filtered.message,
          skipped: filtered.skipped,
          reason: result.reason,
          instanceId,
          evolutionEvent: rawPayload.event || 'unknown',
        });
      }

      // 'send-failed' used to be reported as 'No active webhook configured',
      // which sent whoever was debugging to look at the wrong thing - the
      // webhook was configured fine, the POST to n8n is what failed.
      const failureMessage =
        result.reason === 'send-failed'
          ? 'Webhook configured but delivery to the target URL failed'
          : 'No active webhook configured';

      return res.json({
        success: result.sent,
        message: result.sent ? 'Webhook sent successfully' : failureMessage,
        reason: result.reason,
        instanceId,
        evolutionEvent: rawPayload.event || 'unknown',
      });
    } catch (error: any) {
      console.error('[Webhook] handleIncoming error:', error);
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to process incoming message',
      });
    }
  }

  /**
   * Test webhook
   * POST /api/webhook/test
   */
  async testWebhook(req: Request, res: Response) {
    try {
      const uuid = (req as any).deviceUuid || 'default';

      // Create test payload. from is set at the root as well as inside data,
      // with the same value, so a test delivery has the exact shape a real
      // message has - otherwise a flow reading body.from would pass on real
      // traffic and break on the test button, or the reverse.
      const testPayload = {
        uuid,
        event: 'message.received',
        timestamp: Date.now(),
        from: '201234567890@s.whatsapp.net',
          data: {
            from: '201234567890@s.whatsapp.net',
            fromJid: '201234567890@s.whatsapp.net',
            fromPhone: '201234567890',
            replyTo: '201234567890@s.whatsapp.net',
            fromName: 'Test User',
          to: '201111111111@s.whatsapp.net',
          message: {
            type: 'text',
            body: 'This is a test message from WhatsDeveloper Backend',
          },
          messageId: 'TEST_' + Date.now(),
          isGroup: false,
          // Explicitly false, not omitted: a test delivery must have the same
          // shape a real message has, so a flow branching on fromMe behaves
          // identically for the test button and for live traffic.
          fromMe: false,
        },
      };

      const result = await this.webhookService.sendWebhook(uuid, testPayload);

      // Check result.sent, not the result object. sendWebhook returns a record
      // now, and `!result` would always be false - the 404 below was dead code.
      if (!result.sent) {
        return res.status(404).json({
          success: false,
          error:
            result.reason === 'send-failed'
              ? 'Webhook is configured but the request to it failed'
              : 'No active webhook configured',
          reason: result.reason,
        });
      }

      return res.json({
        success: true,
        message: 'Test webhook sent successfully',
        payload: testPayload,
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to send test webhook',
      });
    }
  }

  /**
   * Get webhook auto-configuration status
   * GET /api/webhook/status
   */
  async getWebhookStatus(req: Request, res: Response) {
    try {
      // Get auto-config service (if available)
      const { AutoConfigService } = await import('../services/auto-config.service');

      const evolutionApiUrl = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
      const evolutionApiKey = process.env.EVOLUTION_API_KEY || '';
      const instanceName = process.env.DEFAULT_INSTANCE_NAME || 'TEST';
      const backendPublicUrl = process.env.BACKEND_PUBLIC_URL || '';
      const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || '';

      const autoConfig = new AutoConfigService({
        evolutionApiUrl,
        evolutionApiKey,
        instanceName,
        backendPublicUrl,
        n8nWebhookUrl,
      });

      const status = await autoConfig.getStatus();

      return res.json({
        success: true,
        autoConfigEnabled: process.env.AUTO_CONFIGURE_WEBHOOKS === 'true',
        instanceName,
        status,
        flow: status.backend.configured && status.evolution.configured
          ? 'WhatsApp → Evolution → Backend → n8n ✅'
          : 'Configuration incomplete ⚠️',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to get webhook status',
      });
    }
  }

  /**
   * Smart Webhook Registration with Auto-Interception
   * POST /api/webhook/smart-register/:instanceId
   *
   * This endpoint:
   * 1. Registers n8n URL in Backend
   * 2. Automatically configures Evolution to send to Backend
   */
  async smartRegister(req: Request, res: Response) {
    try {
      // Both filters default to true so the Manager UI build that predates these
      // fields, or any other caller, keeps the previous behaviour.
      const { url, enabled = true, groupMessages = true, fromMeMessages = true } = req.body;
      const instanceId = req.params.instanceId || (req as any).deviceUuid || req.body.instanceId;

      if (!instanceId) {
        return res.status(400).json({
          success: false,
          error: 'Missing instance ID',
        });
      }

      if (!url) {
        return res.status(400).json({
          success: false,
          error: 'Missing required field: url',
        });
      }

      // Validate URL format
      try {
        new URL(url);
      } catch {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL format',
        });
      }

      console.log(`[Smart Register] Instance: ${instanceId}, n8n URL: ${url}`);

      // Step 1: Register n8n webhook in Backend.
      // Awaited because this is a Postgres write now. registerWebhook returns
      // the canonical instance NAME - the Manager UI calls us with the UUID.
      const storedAs = await this.webhookService.registerWebhook(
        instanceId,
        url,
        enabled,
        groupMessages !== false,
        fromMeMessages !== false,
      );
      console.log(
        `[Smart Register] ✓ Registered n8n webhook in Backend as "${storedAs}" (groups: ${groupMessages !== false}, fromMe: ${fromMeMessages !== false})`,
      );

      // Step 2: Configure Evolution to send to Backend.
      //
      // Plain /api/webhook/incoming, with no instance suffix, to match what
      // AutoConfigService writes. It previously appended /${instanceId}, so an
      // instance wired up here held a different URL than the one the status
      // check compares against, and reported "not configured" while working.
      // handleIncoming resolves the instance from Evolution's payload, so the
      // suffix was never needed.
      const backendPublicUrl = process.env.BACKEND_PUBLIC_URL || 'http://localhost:55453';
      const backendWebhookUrl = `${backendPublicUrl}/api/webhook/incoming`;

      const evolutionApiUrl = process.env.EVOLUTION_API_URL || 'http://localhost:2345';
      const evolutionApiKey = process.env.EVOLUTION_API_KEY || '';

      try {
        const axios = await import('axios');
        await axios.default.post(
          // Evolution keys /webhook/set/ by instance NAME, not UUID. The Manager
          // UI calls us with the UUID, so use the canonical name returned above.
          // encodeURIComponent because names may contain spaces
          // ("Octo Notification").
          `${evolutionApiUrl}/webhook/set/${encodeURIComponent(storedAs)}`,
          {
            webhook: {
              enabled: true,
              url: backendWebhookUrl,
              events: ['MESSAGES_UPSERT'],
              webhookByEvents: false,
              webhookBase64: false,
            },
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': evolutionApiKey,
            },
          }
        );
        console.log(`[Smart Register] ✓ Evolution configured to send to Backend`);
      } catch (error: any) {
        console.error(`[Smart Register] Failed to configure Evolution:`, error.message);
        return res.status(500).json({
          success: false,
          error: 'Registered n8n webhook but failed to configure Evolution. Please configure manually.',
          instanceId,
          n8nUrl: url,
          backendUrl: backendWebhookUrl,
        });
      }

      return res.json({
        success: true,
        message: 'Smart webhook registration successful',
        instanceId,
        instanceName: storedAs,
        n8nUrl: url,
        backendUrl: backendWebhookUrl,
        evolutionConfigured: true,
        groupMessages: groupMessages !== false,
        fromMeMessages: fromMeMessages !== false,
        flow: 'WhatsApp → Evolution → Backend → n8n ✅',
      });
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        error: error.message || 'Failed to register smart webhook',
      });
    }
  }
}
