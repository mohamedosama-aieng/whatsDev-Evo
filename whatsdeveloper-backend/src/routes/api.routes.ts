import { Router } from 'express';
import { MessageController } from '../controllers/message.controller';
import { InstanceController } from '../controllers/instance.controller';
import { SequenceController } from '../controllers/sequence.controller';
import { WebhookController } from '../controllers/webhook.controller';
import { TestController } from '../controllers/test.controller';

/**
 * Route table.
 *
 * IMPORTANT: every endpoint that sends a WhatsApp message or reads chat data
 * carries authMiddleware. They previously did not, which had two consequences:
 *
 *   1. No token was resolved, so controllers fell through to
 *      DEFAULT_INSTANCE_NAME and both profiles sent from the first one.
 *   2. The endpoints were fully open. Anyone able to reach the backend - and it
 *      is reachable through IIS - could send messages from the connected
 *      WhatsApp account.
 *
 * Deliberately left unauthenticated (each is called by a machine that cannot
 * carry a user token):
 *   /api/webhook/incoming*        Evolution posts inbound messages here
 *   /api/webhook/smart-register/  the Evolution Manager UI calls this
 *   /api/webhook/status           read-only health/config view
 *   /health
 */
export function createRouter(
  messageController: MessageController,
  instanceController: InstanceController,
  sequenceController: SequenceController,
  webhookController: WebhookController,
  testController: TestController,
  authMiddleware: any,
): Router {
  const router = Router();

  // Message routes (matching WhatsDeveloper API)
  router.post('/api/send-message', authMiddleware, (req, res) => messageController.sendMessage(req, res));
  router.post('/api/send-image', authMiddleware, (req, res) => messageController.sendImage(req, res));
  router.post('/api/send-video', authMiddleware, (req, res) => messageController.sendVideo(req, res));
  router.post('/api/send-audio', authMiddleware, (req, res) => messageController.sendAudio(req, res));
  router.post('/api/send-document', authMiddleware, (req, res) => messageController.sendDocument(req, res));
  router.post('/api/send-location', authMiddleware, (req, res) => messageController.sendLocation(req, res));
  router.post('/api/send-contact', authMiddleware, (req, res) => messageController.sendContact(req, res));
  router.post('/api/send-buttons', authMiddleware, (req, res) => messageController.sendButtons(req, res));

  // n8n compatibility routes - /api/v1/messages/* endpoints
  router.post('/api/v1/messages/send-text', authMiddleware, (req, res) => messageController.sendText(req, res));
  router.post('/api/v1/messages/send-message', authMiddleware, (req, res) => messageController.sendMessage(req, res));
  router.post('/api/v1/messages/send-image', authMiddleware, (req, res) => messageController.sendImage(req, res));
  router.post('/api/v1/messages/send-video', authMiddleware, (req, res) => messageController.sendVideo(req, res));
  router.post('/api/v1/messages/send-audio', authMiddleware, (req, res) => messageController.sendAudio(req, res));
  router.post('/api/v1/messages/send-document', authMiddleware, (req, res) =>
    messageController.sendDocument(req, res),
  );

  // Sequence route
  router.post('/api/v1/messages/send-sequence', authMiddleware, (req, res) =>
    sequenceController.sendSequence(req, res),
  );
  router.get('/api/v1/messages/send-sequence/:sequenceId', authMiddleware, (req, res) =>
    sequenceController.getSequenceStatus(req, res),
  );

  // Webhook routes
  router.post('/api/webhook/register', authMiddleware, (req, res) => webhookController.registerWebhook(req, res));
  router.post('/api/webhook/register/:instanceId', authMiddleware, (req, res) =>
    webhookController.registerWebhook(req, res),
  );
  // No auth - called by the Evolution Manager UI, which has no backend token.
  router.post('/api/webhook/smart-register/:instanceId', (req, res) => webhookController.smartRegister(req, res));
  // No auth - Manager UI needs to fetch the n8n URL without backend token
  router.get('/api/webhook/config/:instanceId', (req, res) => webhookController.getWebhookConfig(req, res));
  router.get('/api/webhook/status', (req, res) => webhookController.getWebhookStatus(req, res)); // Public
  router.post('/api/webhook/test', authMiddleware, (req, res) => webhookController.testWebhook(req, res));
  // No auth - Evolution posts here. Instance identity comes from the payload.
  router.post('/api/webhook/incoming', (req, res) => webhookController.handleIncoming(req, res));
  router.post('/api/webhook/incoming/:instanceId', (req, res) => webhookController.handleIncoming(req, res));

  // Test routes (for development)
  router.post('/api/test/ad-detection', (req, res) => testController.testAdDetection(req, res));

  // Instance & Chat routes - these read data from a specific profile, so they
  // need the same token resolution as the send endpoints.
  router.get('/api/instance/status', authMiddleware, (req, res) => instanceController.getStatus(req, res));
  router.get('/api/chats', authMiddleware, (req, res) => instanceController.getChats(req, res));
  router.get('/api/messages/:phone', authMiddleware, (req, res) => instanceController.getMessages(req, res));

  // Health check
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'WhatsDeveloper Backend Bridge',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
