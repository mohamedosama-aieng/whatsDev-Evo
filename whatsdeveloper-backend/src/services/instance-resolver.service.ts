import { DbService } from './db.service';

/**
 * Turns an inbound API token into "which WhatsApp profile is this?".
 *
 * Background: every send endpoint used to drop the caller's token on the floor
 * and fall through to DEFAULT_INSTANCE_NAME + the global key, so two profiles
 * both sent from the first one. Evolution already stores a per-instance token
 * (Instance.token) and honours it, so resolution is a lookup, not new state.
 *
 * Token kinds:
 *   - per-instance token  -> that instance, authenticated with that same token
 *   - global API key      -> any instance; caller must say which, else default
 *   - anything else       -> unresolved (caller decides: 401 or legacy fallback)
 */

export type TokenKind = 'instance' | 'global' | 'unknown' | 'absent';

export interface ResolvedInstance {
  kind: TokenKind;
  /** Canonical Evolution instance name, e.g. "OctoBot". */
  instanceName: string;
  /**
   * Key to authenticate the outbound Evolution call. For a per-instance token
   * this is that token, so Evolution scopes the call to that instance itself
   * rather than trusting our routing.
   */
  apiKey: string;
  /** True when we fell back to the default instance instead of resolving. */
  usedFallback: boolean;
}

interface CacheEntry {
  value: { id: string; name: string; connectionStatus: string } | null;
  at: number;
}

export class InstanceResolver {
  private static instance: InstanceResolver;

  // Token lookups sit in front of every send call, so cache them briefly.
  // Short TTL: a token revoked in the Manager should stop working quickly.
  private cache = new Map<string, CacheEntry>();
  private readonly ttlMs = 30_000;

  private globalApiKey = '';
  private defaultInstance = '';

  private constructor() {}

  static getInstance(): InstanceResolver {
    if (!InstanceResolver.instance) {
      InstanceResolver.instance = new InstanceResolver();
    }
    return InstanceResolver.instance;
  }

  configure(globalApiKey: string, defaultInstance: string) {
    this.globalApiKey = globalApiKey;
    this.defaultInstance = defaultInstance;
  }

  /** Drop cached lookups (used after a token changes). */
  clearCache() {
    this.cache.clear();
  }

  private async lookupToken(token: string) {
    const hit = this.cache.get(token);
    if (hit && Date.now() - hit.at < this.ttlMs) {
      return hit.value;
    }

    const db = DbService.getInstance();
    // No DB means no resolution; the caller handles it as 'unknown'.
    if (!db.isReady()) return null;

    const row = await db.findInstanceByToken(token);
    this.cache.set(token, { value: row, at: Date.now() });
    return row;
  }

  /**
   * @param token            raw token from the request, if any
   * @param requestedInstance instance the caller explicitly asked for (body/query)
   */
  async resolve(token: string | undefined, requestedInstance?: string): Promise<ResolvedInstance> {
    if (!token) {
      return {
        kind: 'absent',
        instanceName: requestedInstance || this.defaultInstance,
        apiKey: this.globalApiKey,
        usedFallback: true,
      };
    }

    // Global key: full access, so the caller picks the instance. Without an
    // explicit choice we keep the historical behaviour (default instance).
    if (this.globalApiKey && token === this.globalApiKey) {
      let name = requestedInstance || this.defaultInstance;

      // Accept a UUID here too - the Manager UI passes instance ids around.
      if (requestedInstance) {
        const db = DbService.getInstance();
        if (db.isReady()) {
          const canonical = await db.resolveInstanceName(requestedInstance);
          if (canonical) name = canonical;
        }
      }

      return {
        kind: 'global',
        instanceName: name,
        apiKey: this.globalApiKey,
        usedFallback: !requestedInstance,
      };
    }

    const row = await this.lookupToken(token);
    if (row) {
      // Ignore any requested instance: a per-instance token must not be able
      // to address a different profile.
      return {
        kind: 'instance',
        instanceName: row.name,
        apiKey: token,
        usedFallback: false,
      };
    }

    return {
      kind: 'unknown',
      instanceName: requestedInstance || this.defaultInstance,
      apiKey: this.globalApiKey,
      usedFallback: true,
    };
  }
}
