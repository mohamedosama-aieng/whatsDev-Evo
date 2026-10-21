import { Request, Response, NextFunction } from 'express';
import { InstanceResolver } from '../services/instance-resolver.service';

/**
 * Resolves the caller's token to a WhatsApp profile and attaches it to the
 * request.
 *
 * What this replaced: the old middleware read the token, stashed the raw string
 * on the request, and never looked it up. Controllers then called Evolution
 * with no instance and no key, so every send fell through to
 * DEFAULT_INSTANCE_NAME + the global key. Two profiles, one sender.
 *
 * Downstream contract - controllers read these and must not re-derive them:
 *   req.instanceName  canonical Evolution instance name
 *   req.instanceKey   key to authenticate the outbound Evolution call
 *   req.tokenKind     'instance' | 'global' | 'unknown' | 'absent'
 */

export interface AuthedRequest extends Request {
  apiToken?: string;
  deviceUuid?: string;
  instanceName?: string;
  instanceKey?: string;
  tokenKind?: string;
}

export interface AuthOptions {
  /**
   * Accept requests with a missing or unrecognised token, serving them from the
   * default instance.
   *
   * This exists only so existing n8n workflows keep working during the
   * transition; they currently call the send endpoints with no credentials at
   * all. Every such request is logged with a LEGACY warning. Turn it off
   * (ALLOW_LEGACY_UNAUTHENTICATED=false) once the workflows send a token -
   * while it is on, anyone who can reach the backend can send WhatsApp
   * messages from your profile.
   */
  allowLegacyUnauthenticated: boolean;
}

/**
 * First usable token from the places callers actually put it.
 *
 * Express types are loose here: a header can be string | string[], and a query
 * value can be a nested object (?apikey[x]=y). Everything is narrowed to a
 * plain non-empty string so a malformed request cannot reach the resolver as an
 * object and be treated as a token.
 */
function firstString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  return undefined;
}

function extractToken(req: Request): string | undefined {
  const bearer = firstString(req.headers['authorization'])?.replace(/^Bearer\s+/i, '');

  return (
    firstString(req.headers['x-api-token']) ||
    firstString(req.headers['apikey']) ||
    (bearer && bearer.length > 0 ? bearer : undefined) ||
    firstString(req.query.apikey)
  );
}

/** Instance the caller explicitly asked for. Only honoured for the global key. */
function extractRequestedInstance(req: Request): string | undefined {
  const raw =
    req.body?.instance ||
    req.body?.instanceName ||
    req.body?.instanceId ||
    req.params?.instanceId ||
    req.query?.instance;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

export function createAuthMiddleware(options: AuthOptions) {
  const resolver = InstanceResolver.getInstance();

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const areq = req as AuthedRequest;
      const token = extractToken(req);
      const requestedInstance = extractRequestedInstance(req);

      const resolved = await resolver.resolve(token, requestedInstance);

      // Unusable token. Reject unless legacy mode is carrying old callers.
      if (resolved.kind === 'absent' || resolved.kind === 'unknown') {
        if (!options.allowLegacyUnauthenticated) {
          return res.status(401).json({
            success: false,
            error:
              resolved.kind === 'absent'
                ? 'Missing authentication token. Send X-API-Token with your instance token.'
                : 'Invalid API token: it matches no WhatsApp instance.',
          });
        }

        console.warn(
          `[Auth] LEGACY ${req.method} ${req.path} - token ${resolved.kind}; ` +
            `serving as "${resolved.instanceName}" via the global key. ` +
            `Set ALLOW_LEGACY_UNAUTHENTICATED=false to reject these.`,
        );
      }

      // A per-instance token that named a different profile: honour the token,
      // ignore the request, and say so rather than silently retargeting.
      if (resolved.kind === 'instance' && requestedInstance) {
        const asked = requestedInstance.toLowerCase();
        if (asked !== resolved.instanceName.toLowerCase()) {
          console.warn(
            `[Auth] token for "${resolved.instanceName}" requested "${requestedInstance}"; ` +
              `using the token's own instance.`,
          );
        }
      }

      areq.apiToken = token;
      areq.deviceUuid = (req.headers['x-device-uuid'] as string) || resolved.instanceName;
      areq.instanceName = resolved.instanceName;
      areq.instanceKey = resolved.apiKey;
      areq.tokenKind = resolved.kind;

      next();
    } catch (error: any) {
      console.error('[Auth] resolution failed:', error.message);
      return res.status(500).json({
        success: false,
        error: 'Authentication failed',
      });
    }
  };
}

/**
 * Optional middleware: Log device UUID for analytics
 */
export function logDeviceUuid(req: Request, res: Response, next: NextFunction) {
  const uuid = req.headers['x-device-uuid'];
  if (uuid) {
    console.log(`[Device UUID] ${uuid} - ${req.method} ${req.path}`);
  }
  next();
}
