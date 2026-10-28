import axios from 'axios';
import dotenv from 'dotenv';
import { DbService } from './db.service';

dotenv.config();

export interface AutoConfigOptions {
  evolutionApiUrl: string;
  evolutionApiKey: string;
  /** DEFAULT_INSTANCE_NAME. Only used to decide which profile the single global
   *  N8N_WEBHOOK_URL seeds, and as a fallback when the DB is unavailable. */
  instanceName: string;
  backendPublicUrl: string;
  n8nWebhookUrl: string;
}

export interface InstanceConfigStatus {
  instanceName: string;
  /** Evolution is pointed at this backend for this instance. */
  evolutionConfigured: boolean;
  evolutionUrl: string | null;
  /** We know where to forward this instance's messages (n8n). */
  backendConfigured: boolean;
  backendUrl: string | null;
}

/**
 * Keeps the message path wired up: Evolution -> this backend -> n8n.
 *
 * Why this runs on every boot: Evolution's webhook row lives in its own
 * Postgres table, and the relation to Instance is `onDelete: Cascade`. If an
 * instance row is ever removed or recreated, the webhook row disappears with
 * it and inbound messages stop silently - nothing errors, they just never
 * arrive. Re-asserting the config at startup makes that self-healing.
 *
 * It used to configure ONLY options.instanceName, so a second profile was never
 * touched and never recovered. It now walks every instance Evolution knows.
 */
export class AutoConfigService {
  private options: AutoConfigOptions;

  constructor(options: AutoConfigOptions) {
    this.options = options;
  }

  /** URL Evolution should post inbound messages to. Instance identity comes
   *  from the payload body, so one URL serves every profile. */
  private get backendWebhookUrl(): string {
    return `${this.options.backendPublicUrl}/api/webhook/incoming`;
  }

  async configure(): Promise<void> {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║     Auto-Configuring Webhooks...                     ║');
    console.log('╠═══════════════════════════════════════════════════════╣');

    try {
      await this.waitForEvolution();

      const instances = await this.targetInstances();
      console.log(`║  Instances to configure: ${String(instances.length).padEnd(28)} ║`);

      let ok = 0;
      for (const name of instances) {
        const configured = await this.configureEvolutionWebhook(name);
        await this.seedN8nTarget(name);
        if (configured) ok++;
      }

      console.log('╠═══════════════════════════════════════════════════════╣');
      if (ok === instances.length && ok > 0) {
        console.log('║  ✅ Webhook Auto-Configuration Complete!             ║');
        console.log('║  Flow: WhatsApp → Evolution → Backend → n8n          ║');
      } else {
        console.log(`║  ⚠️  Configured ${ok}/${instances.length}; see warnings above`.padEnd(56) + '║');
      }
      console.log('╚═══════════════════════════════════════════════════════╝');
    } catch (error: any) {
      console.log('╠═══════════════════════════════════════════════════════╣');
      console.log('║  ⚠️  Webhook Auto-Configuration Failed               ║');
      console.log(`║  Error: ${String(error.message).substring(0, 43).padEnd(43)} ║`);
      console.log('║  Backend keeps serving; webhooks need manual setup.  ║');
      console.log('╚═══════════════════════════════════════════════════════╝');
    }
  }

  /**
   * Which instances to wire up.
   *
   * Prefers the DB (authoritative, includes instances this backend has never
   * seen). Falls back to Evolution's REST API, then to the single configured
   * default so a DB outage degrades instead of breaking.
   */
  private async targetInstances(): Promise<string[]> {
    const db = DbService.getInstance();

    // Read both sources and merge them. The DB only contains instances that
    // have already been persisted by the Manager, while Evolution also knows
    // about profiles created/imported outside the Manager. Returning early from
    // either source left those profiles without the shared webhook bridge.
    const names = new Set<string>();

    if (db.isReady()) {
      try {
        const rows = await db.listConnectedInstances();
        for (const row of rows) {
          if (row.name) names.add(row.name);
        }
      } catch (error: any) {
        console.log(`║  ⚠️  DB instance list failed: ${String(error.message).substring(0, 21).padEnd(21)} ║`);
      }
    }

    try {
      const res = await axios.get(`${this.options.evolutionApiUrl}/instance/fetchInstances`, {
        headers: { apikey: this.options.evolutionApiKey },
        timeout: 8000,
      });
      const list = Array.isArray(res.data)
        ? res.data
        : Array.isArray(res.data?.instances)
          ? res.data.instances
          : [];
      for (const instance of list) {
        const name = instance?.name ?? instance?.instance?.instanceName;
        if (typeof name === 'string' && name.length > 0) names.add(name);
      }
    } catch (error: any) {
      console.log(`║  ⚠️  Evolution instance list failed: ${String(error.message).substring(0, 18).padEnd(18)} ║`);
    }

    if (this.options.instanceName) names.add(this.options.instanceName);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  private async waitForEvolution(): Promise<void> {
    console.log('║  [1/2] Waiting for Evolution API...                  ║');

    const maxRetries = 10;
    const retryDelay = 2000;

    for (let i = 0; i < maxRetries; i++) {
      try {
        await axios.get(`${this.options.evolutionApiUrl}/`, { timeout: 3000 });
        console.log('║  ✓ Evolution API is ready                            ║');
        return;
      } catch {
        if (i === maxRetries - 1) {
          throw new Error('Evolution API not responding');
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }
  }

  /**
   * Point one instance's Evolution webhook at this backend.
   * Returns false on a handled failure; only unexpected errors throw.
   */
  private async configureEvolutionWebhook(instanceName: string): Promise<boolean> {
    const label = instanceName.substring(0, 20).padEnd(20);

    try {
      // Instance names may contain spaces ("Octo Notification").
      const response = await axios.post(
        `${this.options.evolutionApiUrl}/webhook/set/${encodeURIComponent(instanceName)}`,
        {
          webhook: {
            enabled: true,
            url: this.backendWebhookUrl,
            events: ['MESSAGES_UPSERT'], // Evolution requires upper snake case
            webhookByEvents: false,
            webhookBase64: false,
          },
        },
        {
          headers: {
            'Content-Type': 'application/json',
            apikey: this.options.evolutionApiKey,
          },
          timeout: 15000,
          validateStatus: (status) => status < 500,
        },
      );

      if (response.status >= 200 && response.status < 300) {
        console.log(`║  ✓ ${label} → backend                    ║`);
        return true;
      }
      if (response.status === 404) {
        console.log(`║  ⚠️  ${label} not found in Evolution   ║`);
        return false;
      }
      if (response.status === 401 || response.status === 403) {
        throw new Error('Invalid Evolution API key');
      }
      console.log(`║  ⚠️  ${label} returned ${response.status}             ║`);
      return false;
    } catch (error: any) {
      if (error.response) {
        console.log(`║  ⚠️  ${label} HTTP ${error.response.status}                ║`);
      } else if (error.request) {
        console.log(`║  ⚠️  ${label} no response            ║`);
      } else {
        console.log(`║  ⚠️  ${label} ${String(error.message).substring(0, 18).padEnd(18)} ║`);
      }
      return false;
    }
  }

  /**
   * Make sure we know where to forward this instance's messages.
   *
   * Insert-only: an existing row is never overwritten, so a target set through
   * the Manager UI survives a restart. N8N_WEBHOOK_URL is a single global
   * value, so it seeds ONLY the default instance - pushing it onto every
   * profile would quietly forward one profile's messages into another
   * profile's workflow.
   */
  private async seedN8nTarget(instanceName: string): Promise<void> {
    const { WebhookService } = await import('./webhook.service');
    const webhookService = WebhookService.getInstance();

    const existing = await webhookService.getWebhookFresh(instanceName);
    if (existing) return;

    const isDefault = instanceName === this.options.instanceName;
    if (isDefault && this.options.n8nWebhookUrl) {
      await webhookService.registerWebhook(instanceName, this.options.n8nWebhookUrl, true);
      console.log(`║  ✓ ${instanceName.substring(0, 20).padEnd(20)} → n8n (seeded)         ║`);
      return;
    }

    console.log(
      `║  ⚠️  ${instanceName.substring(0, 20).padEnd(20)} has no n8n target   ║`,
    );
  }

  /**
   * Per-instance view of the wiring, plus aggregate flags.
   *
   * The aggregate `backend`/`evolution` fields describe the DEFAULT instance and
   * exist because /api/webhook/status already returned that shape.
   */
  async getStatus(): Promise<{
    backend: { configured: boolean; url: string };
    evolution: { configured: boolean; url: string };
    instances: InstanceConfigStatus[];
  }> {
    const { WebhookService } = await import('./webhook.service');
    const webhookService = WebhookService.getInstance();

    let names: string[];
    try {
      names = await this.targetInstances();
    } catch {
      names = this.options.instanceName ? [this.options.instanceName] : [];
    }

    const instances: InstanceConfigStatus[] = [];

    for (const name of names) {
      let evolutionConfigured = false;
      let evolutionUrl: string | null = null;

      try {
        const response = await axios.get(
          `${this.options.evolutionApiUrl}/webhook/find/${encodeURIComponent(name)}`,
          { headers: { apikey: this.options.evolutionApiKey }, timeout: 5000 },
        );
        evolutionUrl = response.data?.url ?? null;
        // Compare against the exact URL configureEvolutionWebhook() writes.
        // These two strings drifted before (one had /api/, the other did not),
        // which reported "not configured" on a working setup.
        evolutionConfigured = response.data?.enabled === true && evolutionUrl === this.backendWebhookUrl;
      } catch {
        evolutionConfigured = false;
      }

      const target = await webhookService.getWebhookFresh(name);

      instances.push({
        instanceName: name,
        evolutionConfigured,
        evolutionUrl,
        backendConfigured: !!target && target.enabled,
        backendUrl: target?.url ?? null,
      });
    }

    const primary = instances.find((i) => i.instanceName === this.options.instanceName) ?? instances[0];

    return {
      backend: {
        configured: primary?.backendConfigured ?? false,
        url: primary?.backendUrl ?? 'not configured',
      },
      evolution: {
        configured: primary?.evolutionConfigured ?? false,
        url: this.backendWebhookUrl,
      },
      instances,
    };
  }
}
