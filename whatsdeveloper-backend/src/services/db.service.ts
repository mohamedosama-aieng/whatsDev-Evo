import { Pool, PoolClient } from 'pg';

/**
 * Thin Postgres access layer.
 *
 * We share Evolution's database (DATABASE_CONNECTION_URI) instead of running a
 * second one. Two things live here:
 *
 *   1. Reads against Evolution's own tables ("Instance") to resolve an
 *      API token -> instance. Evolution already stores a per-instance token,
 *      so there is no need to invent a parallel key store.
 *
 *   2. Our own table (wd_backend_webhook) holding the n8n URL per instance.
 *      This used to be a JSON file next to the process, which meant the
 *      mapping was tied to the working directory and silently vanished when
 *      the process was started from elsewhere.
 *
 * NAMING: our table is prefixed wd_backend_ on purpose. Evolution owns this
 * database and manages it with Prisma. A distinct name keeps `prisma migrate
 * deploy` from touching it. Be aware that `prisma migrate dev` (development
 * only) can report drift and offer a reset - that WOULD drop this table.
 */

const OWN_TABLE = 'wd_backend_webhook';

export class DbService {
  private static instance: DbService;
  private pool: Pool | null = null;
  private ready = false;

  private constructor() {}

  static getInstance(): DbService {
    if (!DbService.instance) {
      DbService.instance = new DbService();
    }
    return DbService.instance;
  }

  /** True once init() has connected and ensured the schema. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Connect and create our table if missing.
   * Throws on failure so the caller can decide whether to continue degraded.
   */
  async init(connectionString: string): Promise<void> {
    if (this.pool) return;

    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    // A pool-level error listener is mandatory. An idle client dropped by the
    // server emits 'error' on the pool, and an unhandled 'error' event takes
    // the whole process down - the same failure mode that killed the Vite dev
    // server behind IIS.
    this.pool.on('error', (err) => {
      console.error('[DB] idle client error (pool stays usable):', err.message);
    });

    const client = await this.pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${OWN_TABLE} (
          instance_name     TEXT PRIMARY KEY,
          url               TEXT    NOT NULL,
          enabled           BOOLEAN NOT NULL DEFAULT true,
          group_messages    BOOLEAN NOT NULL DEFAULT true,
          from_me_messages  BOOLEAN NOT NULL DEFAULT true,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      // Separate from the CREATE above: that statement is a no-op once the
      // table exists, so a column added later never reaches an existing
      // deployment without this. DEFAULT true keeps current behaviour -
      // instances created before these columns keep forwarding both group
      // messages and own (fromMe) messages.
      await client.query(
        `ALTER TABLE ${OWN_TABLE} ADD COLUMN IF NOT EXISTS group_messages BOOLEAN NOT NULL DEFAULT true`,
      );
      await client.query(
        `ALTER TABLE ${OWN_TABLE} ADD COLUMN IF NOT EXISTS from_me_messages BOOLEAN NOT NULL DEFAULT true`,
      );

      this.ready = true;
      console.log(`[DB] connected; ${OWN_TABLE} ready`);
    } finally {
      client.release();
    }
  }

  private assertReady(): Pool {
    if (!this.pool || !this.ready) {
      throw new Error('DbService used before init()');
    }
    return this.pool;
  }

  // ---------------------------------------------------------------------
  // Evolution instance lookups (read-only)
  // ---------------------------------------------------------------------

  /**
   * Resolve a per-instance token to its instance name.
   * Returns null when the token matches no instance.
   */
  async findInstanceByToken(token: string): Promise<{ id: string; name: string; connectionStatus: string } | null> {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      'SELECT id, name, "connectionStatus" FROM "Instance" WHERE token = $1 LIMIT 1',
      [token],
    );
    return rows[0] ?? null;
  }

  /**
   * Resolve a name OR a UUID to the canonical instance name.
   *
   * Needed because the two callers disagree: Evolution's webhook payload
   * carries the instance NAME, while the Manager UI calls smart-register with
   * the instance UUID. Storing under whichever arrived first meant lookups
   * missed. Everything is normalised to the name.
   */
  async resolveInstanceName(nameOrId: string): Promise<string | null> {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      'SELECT name FROM "Instance" WHERE name = $1 OR id = $1 LIMIT 1',
      [nameOrId],
    );
    return rows[0]?.name ?? null;
  }

  /** All instances Evolution currently considers connected. */
  async listConnectedInstances(): Promise<Array<{ id: string; name: string }>> {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      `SELECT id, name FROM "Instance" WHERE "connectionStatus" = 'open' ORDER BY name`,
    );
    return rows;
  }

  /** All instances, regardless of connection state. */
  async listAllInstances(): Promise<Array<{ id: string; name: string; connectionStatus: string }>> {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      'SELECT id, name, "connectionStatus" FROM "Instance" ORDER BY name',
    );
    return rows;
  }

  // ---------------------------------------------------------------------
  // Our webhook table
  // ---------------------------------------------------------------------

  async upsertWebhook(
    instanceName: string,
    url: string,
    enabled: boolean,
    groupMessages: boolean = true,
    fromMeMessages: boolean = true,
  ): Promise<void> {
    const pool = this.assertReady();
    await pool.query(
      `INSERT INTO ${OWN_TABLE} (instance_name, url, enabled, group_messages, from_me_messages, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (instance_name)
       DO UPDATE SET url = EXCLUDED.url,
                     enabled = EXCLUDED.enabled,
                     group_messages = EXCLUDED.group_messages,
                     from_me_messages = EXCLUDED.from_me_messages,
                     updated_at = now()`,
      [instanceName, url, enabled, groupMessages, fromMeMessages],
    );
  }

  async getWebhook(
    instanceName: string,
  ): Promise<{
    url: string;
    enabled: boolean;
    group_messages: boolean;
    from_me_messages: boolean;
  } | null> {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      `SELECT url, enabled, group_messages, from_me_messages FROM ${OWN_TABLE} WHERE instance_name = $1 LIMIT 1`,
      [instanceName],
    );
    return rows[0] ?? null;
  }

  async getAllWebhooks(): Promise<
    Array<{
      instance_name: string;
      url: string;
      enabled: boolean;
      group_messages: boolean;
      from_me_messages: boolean;
    }>
  > {
    const pool = this.assertReady();
    const { rows } = await pool.query(
      `SELECT instance_name, url, enabled, group_messages, from_me_messages FROM ${OWN_TABLE} ORDER BY instance_name`,
    );
    return rows;
  }

  /** Used once at boot to import the legacy .webhooks.json file. */
  async insertWebhookIfAbsent(
    instanceName: string,
    url: string,
    enabled: boolean,
    groupMessages: boolean = true,
    fromMeMessages: boolean = true,
  ): Promise<boolean> {
    const pool = this.assertReady();
    const { rowCount } = await pool.query(
      `INSERT INTO ${OWN_TABLE} (instance_name, url, enabled, group_messages, from_me_messages)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (instance_name) DO NOTHING`,
      [instanceName, url, enabled, groupMessages, fromMeMessages],
    );
    return (rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.ready = false;
    }
  }

  /** Escape hatch for ad-hoc queries; prefer the typed helpers above. */
  async withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const pool = this.assertReady();
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }
}
