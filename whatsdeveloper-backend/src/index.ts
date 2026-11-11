import express, { Application } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';

import { EvolutionService } from './services/evolution.service';
import { WebhookService } from './services/webhook.service';
import { AutoConfigService } from './services/auto-config.service';
import { DbService } from './services/db.service';
import { InstanceResolver } from './services/instance-resolver.service';
import { MessageController } from './controllers/message.controller';
import { InstanceController } from './controllers/instance.controller';
import { SequenceController } from './controllers/sequence.controller';
import { WebhookController } from './controllers/webhook.controller';
import { TestController } from './controllers/test.controller';
import { createRouter } from './routes/api.routes';
import { swaggerSpec } from './config/swagger';
import { createAuthMiddleware } from './middleware/auth.middleware';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 3000;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL || 'http://localhost:8080';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const DEFAULT_INSTANCE_NAME = process.env.DEFAULT_INSTANCE_NAME || 'TEST';
const EVOLUTION_MEDIA_TIMEOUT_MS = Number.parseInt(process.env.EVOLUTION_MEDIA_TIMEOUT_MS || '120000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

// Auto-configuration settings
const AUTO_CONFIGURE_WEBHOOKS = process.env.AUTO_CONFIGURE_WEBHOOKS === 'true';
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || '';
const BACKEND_PUBLIC_URL = process.env.BACKEND_PUBLIC_URL || `http://localhost:${PORT}`;

// Shared with Evolution. Used for two things: resolving a caller's token to a
// WhatsApp profile (Evolution's "Instance" table), and storing our own n8n
// targets (wd_backend_webhook).
const DATABASE_CONNECTION_URI = process.env.DATABASE_CONNECTION_URI || '';

// Transition switch. While true, a request with no token (or an unrecognised
// one) is served from DEFAULT_INSTANCE_NAME and logged as LEGACY. That is how
// the existing n8n workflows call these endpoints today. It also means anyone
// who can reach this backend can send WhatsApp messages, so flip it to false
// once the workflows pass a token.
const ALLOW_LEGACY_UNAUTHENTICATED = process.env.ALLOW_LEGACY_UNAUTHENTICATED !== 'false';

// Initialize Express app
const app: Application = express();

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable CSP for API docs to work
  }),
);

// CORS
app.use(
  cors({
    origin: CORS_ORIGIN,
    credentials: true,
  }),
);

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'),
  max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '100'),
  message: 'Too many requests from this IP, please try again later.',
});
app.use('/api/', limiter);

// Initialize services
//
// One EvolutionService is enough: the global key here is only a fallback. Each
// call takes an explicit instance + key, which the auth middleware resolves
// from the caller's token.
const evolutionService = new EvolutionService({
  baseURL: EVOLUTION_API_URL,
  apiKey: EVOLUTION_API_KEY,
  defaultInstance: DEFAULT_INSTANCE_NAME,
  mediaTimeoutMs: EVOLUTION_MEDIA_TIMEOUT_MS,
});

const webhookService = WebhookService.getInstance();

// Initialize controllers
const messageController = new MessageController(evolutionService);
const instanceController = new InstanceController(evolutionService);
const sequenceController = new SequenceController(evolutionService);
const webhookController = new WebhookController(webhookService);
const testController = new TestController();

const authMiddleware = createAuthMiddleware({
  allowLegacyUnauthenticated: ALLOW_LEGACY_UNAUTHENTICATED,
});

// Setup routes
const router = createRouter(
  messageController,
  instanceController,
  sequenceController,
  webhookController,
  testController,
  authMiddleware,
);
app.use('/', router);

// API Documentation - Serve static HTML
app.get('/api-docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'docs', 'index.html'));
});

// Serve swagger spec as JSON
app.get('/api-docs.json', (req, res) => {
  res.json(swaggerSpec);
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    availableDocs: '/api-docs',
  });
});

// Error handler
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error',
  });
});

/**
 * Bring up the database and load persisted state.
 *
 * Runs before listen() so the first request already has token resolution and
 * the webhook table available. A failure here is not fatal: the backend still
 * serves, but token->instance resolution is impossible, so sends fall back to
 * the default profile. That is loud in the logs on purpose.
 */
async function initPersistence(): Promise<boolean> {
  if (!DATABASE_CONNECTION_URI) {
    console.warn('╔═══════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  DATABASE_CONNECTION_URI is not set               ║');
    console.warn('║  Per-instance API keys cannot be resolved, and n8n    ║');
    console.warn('║  targets will not persist across a restart.           ║');
    console.warn('╚═══════════════════════════════════════════════════════╝');
    return false;
  }

  try {
    await DbService.getInstance().init(DATABASE_CONNECTION_URI);
    return true;
  } catch (error: any) {
    console.error('╔═══════════════════════════════════════════════════════╗');
    console.error('║  ⚠️  Database connection failed                       ║');
    console.error(`║  ${String(error.message).substring(0, 51).padEnd(51)} ║`);
    console.error('║  Running degraded: sends fall back to the default     ║');
    console.error('║  profile and webhook changes are memory-only.         ║');
    console.error('╚═══════════════════════════════════════════════════════╝');
    return false;
  }
}

async function bootstrap() {
  const dbOk = await initPersistence();

  // Resolver needs the global key to tell "full access" from a per-instance
  // token, and the default instance for the legacy fallback.
  InstanceResolver.getInstance().configure(EVOLUTION_API_KEY, DEFAULT_INSTANCE_NAME);

  // Loads the webhook table into cache and imports any legacy .webhooks.json.
  await webhookService.init();

  app.listen(PORT, async () => {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║     WhatsDeveloper Backend Bridge API                ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║  🚀 Server running on: http://localhost:${PORT.toString().padEnd(4)} ║`);
    console.log(`║  📚 API Docs: http://localhost:${PORT}/api-docs          ║`);
    console.log(`║  🔗 Evolution API: ${EVOLUTION_API_URL.padEnd(29)} ║`);
    console.log(`║  📱 Default instance: ${DEFAULT_INSTANCE_NAME.padEnd(29)} ║`);
    console.log(`║  🗄️  Database: ${(dbOk ? 'connected' : 'DEGRADED').padEnd(36)} ║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
    console.log('');

    if (ALLOW_LEGACY_UNAUTHENTICATED) {
      console.warn('╔═══════════════════════════════════════════════════════╗');
      console.warn('║  ⚠️  ALLOW_LEGACY_UNAUTHENTICATED is ON               ║');
      console.warn('║  Requests without a valid token are accepted and      ║');
      console.warn('║  served from the default profile. Anyone who can      ║');
      console.warn('║  reach this port can send WhatsApp messages.          ║');
      console.warn('║  Set ALLOW_LEGACY_UNAUTHENTICATED=false when the n8n  ║');
      console.warn('║  workflows send X-API-Token.                          ║');
      console.warn('╚═══════════════════════════════════════════════════════╝');
      console.warn('');
    }

    // Re-assert the webhook wiring for every instance. Evolution's webhook row
    // cascades away with its instance row, so this is what makes a lost
    // configuration come back by itself after a restart.
    if (AUTO_CONFIGURE_WEBHOOKS) {
      const autoConfig = new AutoConfigService({
        evolutionApiUrl: EVOLUTION_API_URL,
        evolutionApiKey: EVOLUTION_API_KEY,
        instanceName: DEFAULT_INSTANCE_NAME,
        backendPublicUrl: BACKEND_PUBLIC_URL,
        n8nWebhookUrl: N8N_WEBHOOK_URL,
      });

      autoConfig.configure().catch((error) => {
        console.error('Auto-configuration error:', error);
      });
    } else {
      console.log('╔═══════════════════════════════════════════════════════╗');
      console.log('║  ⚠️  Auto-configuration disabled                      ║');
      console.log('║  Set AUTO_CONFIGURE_WEBHOOKS=true to re-assert the    ║');
      console.log('║  Evolution → Backend wiring on every start.           ║');
      console.log('╚═══════════════════════════════════════════════════════╝');
    }
  });
}

bootstrap().catch((error) => {
  console.error('Fatal startup error:', error);
  process.exit(1);
});

// Graceful shutdown
async function shutdown(signal: string) {
  console.log(`${signal} received, shutting down gracefully...`);
  try {
    await DbService.getInstance().close();
  } catch {
    // already closed or never opened
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
