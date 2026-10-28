import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { DbService } from './db.service';

export interface WebhookConfig {
  url: string;
  enabled: boolean;
  /**
   * Forward messages that arrive from a WhatsApp group (JID ending @g.us).
   *
   * true  - group messages are forwarded to n8n (previous behaviour)
   * false - group messages are dropped here and never reach n8n
   *
   * Defaults to true everywhere so an instance registered before this option
   * existed keeps behaving exactly as it did.
   */
  groupMessages: boolean;
  /**
   * Forward messages the instance itself sent (key.fromMe === true).
   *
   * true  - own outgoing messages are forwarded to n8n (previous behaviour)
   * false - own outgoing messages are dropped here and never reach n8n
   *
   * Worth knowing why this matters: Evolution's MESSAGES_UPSERT fires for
   * outgoing messages too, so a flow that replies to every inbound message can
   * see its own reply come back and answer itself. Turning this off breaks that
   * loop at the source instead of needing a fromMe guard in every n8n flow.
   *
   * Defaults to true everywhere so an instance registered before this option
   * existed keeps behaving exactly as it did.
   */
  fromMeMessages: boolean;
}

/** Outcome of an attempted forward, so callers can tell "dropped" from "failed". */
export type SendWebhookResult = {
  sent: boolean;
  reason?: 'no-webhook' | 'group-filtered' | 'from-me-filtered' | 'send-failed';
};

export interface WebhookPayload {
  uuid: string;
  event: string;
  timestamp: number;
  /**
   * Sender, duplicated at the root so consumers can read body.from without
   * reaching into body.data. Always the same value as data.from - both are
   * assigned from one variable in transformMessage so they cannot drift.
   * data.from is kept as-is: removing it would break every existing n8n flow.
   */
  from: string;
  data: {
    from: string;
    /** Full sender JID. For unresolved LIDs this is the only safe reply target. */
    fromJid: string;
    /** Public phone number when WhatsApp supplied/resolved one; empty for an unresolved LID. */
    fromPhone?: string;
    /** Target to pass back to the send API. It may be a phone number or a full @lid JID. */
    replyTo: string;
    /** Original Local Identifier when the incoming message used @lid. */
    fromLid?: string;
    fromName?: string;
    to: string;
    message?: {
      type: string;
      body?: string;
      caption?: string;
      url?: string;
      mimetype?: string;
      filename?: string;
      latitude?: number;
      longitude?: number;
      contactName?: string;
      contactNumber?: string;
    };
    messageId: string;
    isGroup: boolean;
    /**
     * True when the instance itself sent this message, straight from
     * Evolution's key.fromMe. Exposed in the payload (not just used for
     * filtering) so a flow that keeps own messages forwarded can still tell
     * inbound from outbound without inspecting jids.
     */
    fromMe: boolean;
    groupName?: string;
    isAd?: boolean;
    adMetadata?: {
      isForwarded: boolean;
      forwardingScore: number;
      detectionReason: string[];
      extractedUrls?: string[];
      sourceUrl?: string;
      title?: string;
      caption?: string;
      postCaption?: string;
      body?: string;
      thumbnailUrl?: string;
      mediaType?: string;
      adSource?: string;
      conversionSource?: string;
      conversionData?: any;
      sourceId?: string;
      ctwaClid?: string;
      showAdAttribution?: boolean;
      sourceApp?: string;
      entryPointConversionSource?: string;
      entryPointConversionApp?: string;
      entryPointConversionExternalSource?: string;
      conversionDelaySeconds?: number;
      mediaUrl?: string;
      originalImageUrl?: string;
      greetingMessageBody?: string;
    };
    /** Normalized Click-to-WhatsApp/Facebook ad context for n8n routing. */
    isAdvertisement?: boolean;
    advertisement?: {
      sourceUrl?: string;
      displayText?: string;
      title?: string;
      caption?: string;
      postCaption?: string;
      body?: string;
      thumbnailUrl?: string;
      mediaType?: string;
      adSource?: string;
      conversionSource?: string;
      conversionData?: any;
      sourceId?: string;
      ctwaClid?: string;
      showAdAttribution?: boolean;
      sourceApp?: string;
      entryPointConversionSource?: string;
      entryPointConversionApp?: string;
      entryPointConversionExternalSource?: string;
      conversionDelaySeconds?: number;
      mediaUrl?: string;
      originalImageUrl?: string;
      greetingMessageBody?: string;
    };
  };
}

export class WebhookService {
  private static instance: WebhookService;

  /**
   * Write-through cache of instance name -> n8n target.
   *
   * Postgres is the source of truth (table wd_backend_webhook). This map only
   * exists so lookups on the hot path (every inbound WhatsApp message) and the
   * synchronous getWebhook() callers do not need to await a query.
   */
  private webhooks: Map<string, WebhookConfig> = new Map();

  /** Legacy store, read once at boot and then migrated into Postgres. */
  private legacyFile: string;

  private constructor() {
    this.legacyFile = path.join(process.cwd(), '.webhooks.json');
  }

  /**
   * Get singleton instance
   */
  static getInstance(): WebhookService {
    if (!WebhookService.instance) {
      WebhookService.instance = new WebhookService();
    }
    return WebhookService.instance;
  }

  /**
   * Load from Postgres, importing .webhooks.json the first time.
   *
   * Must be awaited during startup, before anything reads the cache.
   *
   * Why this replaced the JSON file: the path was
   * `path.join(process.cwd(), '.webhooks.json')`, so the mapping was tied to
   * whatever directory the process happened to start in. Launched from another
   * folder, the backend came up with zero webhooks and no error - the reported
   * "webhook URL does not come back after a restart".
   */
  async init(): Promise<void> {
    const db = DbService.getInstance();
    if (!db.isReady()) {
      console.warn('[Webhook] DB not ready; falling back to legacy file (not persisted)');
      this.loadLegacyIntoCache();
      return;
    }

    await this.migrateLegacyFile();

    const rows = await db.getAllWebhooks();
    this.webhooks = new Map(
      rows.map((r) => [
        r.instance_name,
        {
          url: r.url,
          enabled: r.enabled,
          groupMessages: r.group_messages !== false,
          fromMeMessages: r.from_me_messages !== false,
        },
      ]),
    );
    console.log(`[Webhook] Loaded ${this.webhooks.size} webhook(s) from Postgres`);
  }

  /** Degraded path only: cache without persistence. */
  private loadLegacyIntoCache() {
    try {
      if (fs.existsSync(this.legacyFile)) {
        const data = JSON.parse(fs.readFileSync(this.legacyFile, 'utf-8'));
        this.webhooks = new Map(Object.entries(data) as Array<[string, WebhookConfig]>);
        console.log(`[Webhook] Loaded ${this.webhooks.size} webhook(s) from legacy file`);
      }
    } catch (error) {
      console.error('[Webhook] Failed to read legacy file:', error);
    }
  }

  /**
   * Copy .webhooks.json rows into Postgres without clobbering newer DB values.
   * Insert-if-absent, so re-running is harmless. The file is left on disk and
   * renamed to .migrated so a bad migration stays diagnosable.
   */
  private async migrateLegacyFile(): Promise<void> {
    if (!fs.existsSync(this.legacyFile)) return;

    const db = DbService.getInstance();
    try {
      const data = JSON.parse(fs.readFileSync(this.legacyFile, 'utf-8')) as Record<string, WebhookConfig>;
      let imported = 0;

      for (const [key, cfg] of Object.entries(data)) {
        if (!cfg?.url) continue;
        // Keys in the file may be a name or a UUID; normalise to the name.
        const canonical = (await db.resolveInstanceName(key)) ?? key;
        // Legacy rows predate group_messages and from_me_messages, so both
        // fields are undefined here and resolve to true - the behaviour those
        // rows already had.
        if (
          await db.insertWebhookIfAbsent(
            canonical,
            cfg.url,
            cfg.enabled !== false,
            cfg.groupMessages !== false,
            cfg.fromMeMessages !== false,
          )
        ) {
          imported++;
          console.log(`[Webhook] Migrated ${key} -> ${canonical}`);
        }
      }

      console.log(`[Webhook] Legacy migration: ${imported} row(s) imported`);
      fs.renameSync(this.legacyFile, `${this.legacyFile}.migrated`);
    } catch (error: any) {
      console.error('[Webhook] Legacy migration failed:', error.message);
    }
  }

  /**
   * Register the n8n target for an instance.
   *
   * `instanceKey` may be a name or a UUID; it is normalised to the canonical
   * instance name so that inbound messages (which carry the name) match what
   * the Manager UI registered (which uses the UUID).
   */
  async registerWebhook(
    instanceKey: string,
    url: string,
    enabled: boolean = true,
    groupMessages: boolean = true,
    fromMeMessages: boolean = true,
  ): Promise<string> {
    const db = DbService.getInstance();
    let key = instanceKey;

    if (db.isReady()) {
      key = (await db.resolveInstanceName(instanceKey)) ?? instanceKey;
      await db.upsertWebhook(key, url, enabled, groupMessages, fromMeMessages);
    } else {
      console.warn(`[Webhook] DB not ready; ${key} registered in memory only`);
    }

    const config: WebhookConfig = { url, enabled, groupMessages, fromMeMessages };
    const flags = `groups: ${groupMessages}, fromMe: ${fromMeMessages}`;

    this.webhooks.set(key, config);
    if (key !== instanceKey) {
      // Keep the alias resolvable in-process so a caller using the UUID still hits.
      // A separate object, not the same reference: sharing one would let a later
      // in-place edit of either entry silently change the other.
      this.webhooks.set(instanceKey, { ...config });
      console.log(`[Webhook] Registered for ${instanceKey} (as ${key}) → ${url} (${flags})`);
    } else {
      console.log(`[Webhook] Registered for ${key} → ${url} (${flags})`);
    }
    return key;
  }

  /**
   * Get webhook config. Reads the cache, so it stays synchronous for existing
   * callers; the cache is filled by init() and kept current by registerWebhook.
   */
  getWebhook(instanceKey: string): WebhookConfig | undefined {
    return this.webhooks.get(instanceKey);
  }

  /** Bypass the cache and read Postgres directly. */
  async getWebhookFresh(instanceKey: string): Promise<WebhookConfig | undefined> {
    const db = DbService.getInstance();
    if (!db.isReady()) return this.webhooks.get(instanceKey);

    const key = (await db.resolveInstanceName(instanceKey)) ?? instanceKey;
    const row = await db.getWebhook(key);
    return row
      ? {
          url: row.url,
          enabled: row.enabled,
          groupMessages: row.group_messages !== false,
          fromMeMessages: row.from_me_messages !== false,
        }
      : undefined;
  }

  /** Every registered mapping (used by the status endpoint). */
  listWebhooks(): Array<{
    instanceName: string;
    url: string;
    enabled: boolean;
    groupMessages: boolean;
    fromMeMessages: boolean;
  }> {
    return Array.from(this.webhooks.entries()).map(([instanceName, cfg]) => ({
      instanceName,
      url: cfg.url,
      enabled: cfg.enabled,
      groupMessages: cfg.groupMessages !== false,
      fromMeMessages: cfg.fromMeMessages !== false,
    }));
  }

  /**
   * Send webhook payload.
   *
   * Returns a reason rather than a bare false so the caller can tell a
   * deliberate skip (group filtering) apart from a misconfiguration. Logging
   * "No active webhook" for a filtered group message was actively misleading.
   */
  async sendWebhook(uuid: string, payload: WebhookPayload): Promise<SendWebhookResult> {
    let config = this.webhooks.get(uuid);

    // Cache miss can mean the row was written by another process (or this one
    // booted before it existed), so confirm against the DB before giving up.
    if (!config) {
      config = await this.getWebhookFresh(uuid);
      if (config) this.webhooks.set(uuid, config);
    }

    if (!config || !config.enabled) {
      console.log(`[Webhook] No active webhook for UUID: ${uuid}`);
      return { sent: false, reason: 'no-webhook' };
    }

    // Group filter. Undefined counts as enabled so a row written before this
    // column existed, or a degraded in-memory entry, keeps forwarding.
    if (payload.data?.isGroup && config.groupMessages === false) {
      console.log(
        `[Webhook] Skipped group message for ${uuid} (group messages disabled): ${payload.data.messageId}`,
      );
      return { sent: false, reason: 'group-filtered' };
    }

    // Own-message filter, same `=== false` shape and for the same reason: a row
    // predating the column, or an in-memory entry from the degraded path, has
    // undefined here and must keep forwarding.
    if (payload.data?.fromMe && config.fromMeMessages === false) {
      console.log(
        `[Webhook] Skipped own message for ${uuid} (fromMe messages disabled): ${payload.data.messageId}`,
      );
      return { sent: false, reason: 'from-me-filtered' };
    }

    try {
      await axios.post(config.url, payload, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Source': 'WhatsDeveloper',
        },
        timeout: 10000,
      });

      console.log(`[Webhook] Sent to ${config.url} for UUID: ${uuid}`);
      return { sent: true };
    } catch (error: any) {
      console.error(`[Webhook] Failed to send to ${config.url}:`, error.message);
      return { sent: false, reason: 'send-failed' };
    }
  }

  /**
   * Is this message from a WhatsApp group?
   *
   * Groups are identified by the @g.us suffix. remoteJid is the normal carrier,
   * but participant (the individual sender inside a group) and the message id
   * are checked too, because on some Evolution payload shapes - notably @lid
   * senders - remoteJid is not the group jid.
   */
  isGroupMessage(evolutionMessage: any): boolean {
    const key = evolutionMessage?.key || {};
    const candidates = [key.remoteJid, key.participant, key.id, evolutionMessage?.participant];
    return candidates.some((value) => typeof value === 'string' && value.includes('@g.us'));
  }

  /**
   * Did the instance itself send this message?
   *
   * key.fromMe is Evolution's own flag, so this is a read rather than a guess.
   * Coerced with === true because the field is occasionally absent on some
   * payload shapes, and `undefined` must mean inbound - not be passed through
   * as a falsy-but-not-false value that the filter then has to interpret.
   */
  isFromMe(evolutionMessage: any): boolean {
    return evolutionMessage?.key?.fromMe === true;
  }

  /**
   * Transform Evolution message to WhatsDeveloper webhook payload
   */
  transformMessage(evolutionMessage: any, uuid: string): WebhookPayload {
    console.log('[Webhook] Transforming message:', JSON.stringify(evolutionMessage, null, 2));

    const key = evolutionMessage.key || {};
    const message = evolutionMessage.message || {};
    const messageType = this.detectMessageType(message);

    // Prefer Evolution's resolved public JID. If the message is still a LID,
    // keep the complete @lid value because stripping the suffix turns it into
    // a different (and undeliverable) WhatsApp number.
    const rawFromJid = key.remoteJid || '';
    const fromJid = rawFromJid.includes('@lid') && key.remoteJidAlt
      ? key.remoteJidAlt
      : rawFromJid;
    const fromPhone = fromJid && !fromJid.includes('@lid') ? fromJid.split('@')[0] : '';
    const fromLid = key.remoteJidLid || (rawFromJid.includes('@lid') ? rawFromJid : undefined);
    // Resolved once and used for both payload.from and payload.data.from, so
    // the root-level copy can never disagree with the nested one.
    const from = fromPhone || fromJid;

    // Use mediaUrl from Evolution (local CDN) if available
    // If not available, we'll construct it based on LOCAL_STORAGE pattern
    let mediaUrl = evolutionMessage.mediaUrl || null;

    // If mediaUrl is not in the payload, check if we can construct it
    // Evolution stores media as: {BASE_URL}/media/{type}/{date}/{timestamp}-{id}.{ext}
    // But since we don't have the exact filename, we'll use the WhatsApp URL as fallback
    // and log a warning

    const payload: WebhookPayload = {
      uuid,
      event: 'message.received',
      timestamp: evolutionMessage.messageTimestamp
        ? (typeof evolutionMessage.messageTimestamp === 'number'
            ? evolutionMessage.messageTimestamp * 1000
            : evolutionMessage.messageTimestamp)
        : Date.now(),
      from,
      data: {
        from,
        fromJid,
        fromPhone,
        replyTo: fromJid,
        fromLid,
        fromName: evolutionMessage.pushName || '',
        // For a direct chat this is the same safe target as replyTo. Keep the
        // participant for group messages, where it identifies the sender.
        to: this.isGroupMessage(evolutionMessage) ? key.participant || key.remoteJid || '' : fromJid,
        messageId: key.id || '',
        // Via the helper so the payload flag and the group filter in
        // sendWebhook can never disagree about what counts as a group.
        isGroup: this.isGroupMessage(evolutionMessage),
        // Same reasoning: one helper feeds both the payload field and the
        // fromMe filter, so they cannot drift apart.
        fromMe: this.isFromMe(evolutionMessage),
        groupName: evolutionMessage.groupName || '',
      },
    };

    // Evolution's prepareMessage keeps contextInfo beside `message` after it
    // flattens extendedTextMessage into conversation. Ad metadata therefore
    // cannot be read reliably from `message` alone.
    const adDetection = this.detectAd(message, evolutionMessage);
    if (adDetection.isAd) {
      payload.data.isAd = true;
      payload.data.adMetadata = adDetection.metadata;
      payload.data.isAdvertisement = true;
      payload.data.advertisement = adDetection.advertisement;
    }

    // Extract message content based on type
    switch (messageType) {
      case 'text':
        const textBody = message.conversation ||
                        message.extendedTextMessage?.text ||
                        '';
        payload.data.message = {
          type: 'text',
          body: textBody,
        };
        console.log(`[Webhook] Text message extracted: "${textBody}"`);
        break;

      case 'image':
        payload.data.message = {
          type: 'image',
          caption: message.imageMessage?.caption || '',
          url: mediaUrl || message.imageMessage?.url || '', // ← استخدم mediaUrl أولاً
          mimetype: message.imageMessage?.mimetype || 'image/jpeg',
        };
        console.log(`[Webhook] Image message - URL: ${mediaUrl || 'WhatsApp CDN'}`);
        break;

      case 'video':
        payload.data.message = {
          type: 'video',
          caption: message.videoMessage?.caption || '',
          url: mediaUrl || message.videoMessage?.url || '', // ← استخدم mediaUrl أولاً
          mimetype: message.videoMessage?.mimetype || 'video/mp4',
        };
        console.log(`[Webhook] Video message - URL: ${mediaUrl || 'WhatsApp CDN'}`);
        break;

      case 'audio':
        payload.data.message = {
          type: 'audio',
          url: mediaUrl || message.audioMessage?.url || '', // ← استخدم mediaUrl أولاً
          mimetype: message.audioMessage?.mimetype || 'audio/ogg',
        };
        console.log(`[Webhook] Audio message - URL: ${mediaUrl || 'WhatsApp CDN'}`);
        break;

      case 'document':
        payload.data.message = {
          type: 'document',
          caption: message.documentMessage?.caption || '',
          url: mediaUrl || message.documentMessage?.url || '', // ← استخدم mediaUrl أولاً
          filename: message.documentMessage?.fileName || 'document',
          mimetype: message.documentMessage?.mimetype || 'application/octet-stream',
        };
        console.log(`[Webhook] Document message - URL: ${mediaUrl || 'WhatsApp CDN'}`);
        break;

      case 'location':
        payload.data.message = {
          type: 'location',
          latitude: message.locationMessage?.degreesLatitude || 0,
          longitude: message.locationMessage?.degreesLongitude || 0,
        };
        break;

      case 'contact':
        const vcard = message.contactMessage?.vcard || '';
        const contactName = this.extractVCardName(vcard);
        const contactNumber = this.extractVCardPhone(vcard);

        payload.data.message = {
          type: 'contact',
          contactName,
          contactNumber,
        };
        break;

      default:
        console.log(`[Webhook] Unknown message type, raw message:`, message);
        payload.data.message = {
          type: 'unknown',
          body: JSON.stringify(message),
        };
    }

    console.log('[Webhook] Final transformed payload:', JSON.stringify(payload, null, 2));
    return payload;
  }

  /**
   * Detect message type from Evolution message object
   */
  private detectMessageType(message: any): string {
    if (message.conversation || message.extendedTextMessage) return 'text';
    if (message.imageMessage) return 'image';
    if (message.videoMessage) return 'video';
    if (message.audioMessage) return 'audio';
    if (message.documentMessage) return 'document';
    if (message.locationMessage) return 'location';
    if (message.contactMessage) return 'contact';
    return 'unknown';
  }

  /**
   * Extract name from vCard
   */
  private extractVCardName(vcard: string): string {
    const match = vcard.match(/FN:(.*)/);
    return match ? match[1].trim() : 'Unknown';
  }

  /**
   * Extract phone from vCard
   */
  private extractVCardPhone(vcard: string): string {
    const match = vcard.match(/TEL[^:]*:(.*)/);
    return match ? match[1].trim() : '';
  }

  /**
   * Detect if message is a Facebook Ad
   */
  private detectAd(message: any, evolutionMessage: any = {}): { isAd: boolean; metadata?: any; advertisement?: any } {
    const reasons: string[] = [];
    let isForwarded = false;
    let forwardingScore = 0;
    const extractedUrls: string[] = [];

    // Get message text
    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      message.imageMessage?.caption ||
      message.videoMessage?.caption ||
      '';

    // Depending on the Baileys/Evolution version, ad metadata can be inside
    // the content node or on the prepared message itself.
    const nestedMessage =
      message.ephemeralMessage?.message ||
      message.viewOnceMessage?.message ||
      message.viewOnceMessageV2?.message ||
      message.documentWithCaptionMessage?.message ||
      {};
    const contextInfo =
      evolutionMessage.contextInfo ||
      message.contextInfo ||
      evolutionMessage.messageContextInfo ||
      message.messageContextInfo ||
      message.extendedTextMessage?.contextInfo ||
      message.imageMessage?.contextInfo ||
      message.videoMessage?.contextInfo ||
      nestedMessage.messageContextInfo ||
      nestedMessage.extendedTextMessage?.contextInfo ||
      nestedMessage.imageMessage?.contextInfo ||
      nestedMessage.videoMessage?.contextInfo ||
      {};
    const ctwaContext =
      evolutionMessage.ctwaContext ||
      message.ctwaContext ||
      nestedMessage.ctwaContext ||
      contextInfo.ctwaContext ||
      null;
    const referral =
      evolutionMessage.referral ||
      message.referral ||
      nestedMessage.referral ||
      contextInfo.referral ||
      contextInfo.externalAdReply ||
      contextInfo.adReply ||
      null;
    const referralSourceUrl = referral?.sourceUrl || referral?.url || '';
    const sourceUrl = ctwaContext?.sourceUrl || referralSourceUrl || '';
    const sourceApp =
      ctwaContext?.sourceApp ||
      referral?.sourceApp ||
      evolutionMessage.entryPointConversionApp ||
      contextInfo.entryPointConversionApp ||
      undefined;
    const entryPointConversionSource =
      evolutionMessage.entryPointConversionSource ||
      contextInfo.entryPointConversionSource ||
      undefined;
    const entryPointConversionApp =
      evolutionMessage.entryPointConversionApp ||
      contextInfo.entryPointConversionApp ||
      undefined;
    const entryPointConversionExternalSource =
      evolutionMessage.entryPointConversionExternalSource ||
      contextInfo.entryPointConversionExternalSource ||
      undefined;
    const conversionSource =
      ctwaContext?.conversionSource ||
      referral?.conversionSource ||
      evolutionMessage.conversionSource ||
      contextInfo.conversionSource ||
      undefined;
    const conversionData =
      ctwaContext?.conversionData ||
      referral?.conversionData ||
      evolutionMessage.conversionData ||
      contextInfo.conversionData ||
      undefined;
    const isCtwaEntryPoint = entryPointConversionSource === 'ctwa_ad' || entryPointConversionSource === 'post_cta';
    const isFacebookUrl = (value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      try {
        const hostname = new URL(value).hostname.toLowerCase();
        return (
          hostname === 'fb.me' ||
          hostname.endsWith('.facebook.com') ||
          hostname === 'facebook.com' ||
          hostname.endsWith('.instagram.com') ||
          hostname === 'instagram.com'
        );
      } catch {
        return false;
      }
    };
    const hasFacebookReferral = Boolean(referral && isFacebookUrl(sourceUrl));
    const hasAdContext = Boolean(
      ctwaContext ||
      evolutionMessage.referral ||
      message.referral ||
      contextInfo.adReply ||
      sourceApp ||
      isCtwaEntryPoint ||
      conversionSource === 'FB_Ads' ||
      conversionSource === 'FB_Post' ||
      (referral && (referral.showAdAttribution || referral.sourceType || referral.ctwaClid || hasFacebookReferral)),
    );
    const adCaption =
      ctwaContext?.displayText ||
      ctwaContext?.adBody ||
      referral?.displayText ||
      referral?.body ||
      referral?.description ||
      '';
    const adTitle = ctwaContext?.title || ctwaContext?.headline || referral?.title || referral?.headline || '';
    const advertisement = {
      sourceUrl: sourceUrl || undefined,
      displayText: ctwaContext?.displayText || referral?.displayText || adCaption || undefined,
      title: adTitle || undefined,
      caption: adCaption || undefined,
      postCaption: adCaption || undefined,
      body: referral?.body || ctwaContext?.adBody || undefined,
      thumbnailUrl: ctwaContext?.thumbnailUrl || referral?.thumbnailUrl || undefined,
      mediaType: ctwaContext?.mediaType || referral?.mediaType || undefined,
      adSource: sourceApp === 'instagram' ? 'instagram' : ctwaContext ? 'ctwaContext' : hasFacebookReferral ? 'referral' : undefined,
      conversionSource,
      conversionData,
      sourceId: ctwaContext?.sourceId || referral?.sourceId || undefined,
      ctwaClid: ctwaContext?.ctwaClid || referral?.ctwaClid || undefined,
      showAdAttribution: referral?.showAdAttribution || undefined,
      sourceApp,
      entryPointConversionSource,
      entryPointConversionApp,
      entryPointConversionExternalSource,
      conversionDelaySeconds: evolutionMessage.conversionDelaySeconds || contextInfo.conversionDelaySeconds || undefined,
      mediaUrl: referral?.mediaUrl || undefined,
      originalImageUrl: referral?.originalImageUrl || undefined,
      greetingMessageBody: referral?.greetingMessageBody || undefined,
    };

    // Check 1: Is Forwarded
    if (contextInfo.isForwarded === true) {
      isForwarded = true;
      reasons.push('isForwarded');
    }

    // Check 2: Forwarding Score
    if (contextInfo.forwardingScore && contextInfo.forwardingScore > 0) {
      forwardingScore = contextInfo.forwardingScore;
      reasons.push(`forwardingScore:${forwardingScore}`);
    }

    // Check 3: Ad Text Patterns (case-insensitive)
    const adPatterns = [
      /click here/i,
      /shop now/i,
      /learn more/i,
      /buy now/i,
      /get offer/i,
      /limited time/i,
      /special offer/i,
      /exclusive deal/i,
      /احصل على/i,
      /تسوق الآن/i,
      /عرض خاص/i,
      /عرض محدود/i,
    ];

    for (const pattern of adPatterns) {
      if (pattern.test(text)) {
        reasons.push(`text_pattern:${pattern.source}`);
        break;
      }
    }

    // Check 4: URL Patterns
    const urlPattern = /(https?:\/\/[^\s]+)/gi;
    const urls = text.match(urlPattern) || [];

    for (const url of urls) {
      extractedUrls.push(url);

      // Facebook ad domains
      if (
        url.includes('facebook.com/ads') ||
        url.includes('l.facebook.com') ||
        url.includes('fb.me') ||
        url.includes('fbclid=')
      ) {
        reasons.push(`url_pattern:${url.substring(0, 50)}`);
      }
    }

    // Check 5: Sponsored indicator
    if (text.toLowerCase().includes('sponsored') || text.toLowerCase().includes('إعلان')) {
      reasons.push('sponsored_text');
    }

    // Determine if it's an ad
    // CTWA/referral metadata is the authoritative signal. A Facebook URL in
    // an external ad reply is also enough; ordinary non-Facebook link previews
    // must not be mislabeled as ads.
    if (hasAdContext) reasons.push('ctwa_context');
    if (hasFacebookReferral) reasons.push('facebook_referral');

    const isAd = reasons.length > 0 || (isForwarded && forwardingScore > 0);

    if (!isAd) {
      return { isAd: false };
    }

    return {
      isAd: true,
      metadata: {
        isForwarded,
        forwardingScore,
        detectionReason: reasons,
        extractedUrls: extractedUrls.length > 0 ? extractedUrls : undefined,
        sourceUrl: advertisement.sourceUrl,
        title: advertisement.title,
        caption: advertisement.caption,
        postCaption: advertisement.postCaption,
        body: advertisement.body,
        thumbnailUrl: advertisement.thumbnailUrl,
        mediaType: advertisement.mediaType,
        adSource: advertisement.adSource,
        conversionSource: advertisement.conversionSource,
        conversionData: advertisement.conversionData,
        sourceId: advertisement.sourceId,
        ctwaClid: advertisement.ctwaClid,
        showAdAttribution: advertisement.showAdAttribution,
        sourceApp: advertisement.sourceApp,
        entryPointConversionSource: advertisement.entryPointConversionSource,
        entryPointConversionApp: advertisement.entryPointConversionApp,
        entryPointConversionExternalSource: advertisement.entryPointConversionExternalSource,
        conversionDelaySeconds: advertisement.conversionDelaySeconds,
        mediaUrl: advertisement.mediaUrl,
        originalImageUrl: advertisement.originalImageUrl,
        greetingMessageBody: advertisement.greetingMessageBody,
      },
      advertisement,
    };
  }
}
