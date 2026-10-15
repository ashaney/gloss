/**
 * Local Postgres, through a pg Pool. Server-side only.
 * DATABASE_URL is a plain pg connection string (e.g.
 * postgres:///gloss?host=/var/run/postgresql).
 */

import { Pool, type PoolClient } from "pg";

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set.");
    pool = new Pool({ connectionString: url });
  }
  return pool;
}

/** Run one query against the pool; returns the row array. */
export async function query(text: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const r = await getPool().query(text, params as unknown[] | undefined);
  return r.rows as Record<string, unknown>[];
}

/** Compatibility handle for call sites that use db().query(...): same row-array shape as the old driver. */
export function db() {
  return { query };
}

/** The tables the sync route reads and writes. Names are only ever taken from this list. */
export const COLLECTIONS = ["articles", "highlights", "glosses", "briefs", "progress"] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const isCollection = (v: unknown): v is Collection => typeof v === "string" && (COLLECTIONS as readonly string[]).includes(v);

export type PushRow = { id: string; article_id: string; data: unknown; deleted: boolean; doc?: unknown };
export type PullRow = { id: string; articleId: string; data: unknown; deleted: boolean };

async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Rows changed since `since` in every collection, tombstones included, plus the server clock to pull from next time. */
export async function pullRows(userId: string, since: string): Promise<{ now: string; changes: Record<Collection, PullRow[]> }> {
  return withTransaction(async (client) => {
    const clock = await client.query("select now() as now");
    const changes = {} as Record<Collection, PullRow[]>;
    for (const t of COLLECTIONS) {
      const r = await client.query(`select id, article_id, data, deleted from ${t} where user_id = $1 and updated_at > $2 order by updated_at`, [userId, since]);
      changes[t] = r.rows.map((row) => ({ id: String(row.id), articleId: String(row.article_id), data: row.deleted ? null : row.data, deleted: Boolean(row.deleted) }));
    }
    return { now: new Date(clock.rows[0].now as string).toISOString(), changes };
  });
}

/** Upsert every collection's rows in one transaction. The server stamps the time, so the latest write wins. */
export async function pushRows(userId: string, changes: Partial<Record<Collection, PushRow[]>>): Promise<void> {
  const entries = Object.entries(changes).filter(([t, rows]) => isCollection(t) && rows?.length) as [Collection, PushRow[]][];
  // A text taken off the shelf takes its painted cover with it.
  const gone = (changes.articles ?? []).filter((r) => r.deleted).map((r) => r.id);
  if (!entries.length && !gone.length) return;
  await withTransaction(async (client) => {
    for (const [t, rows] of entries) await client.query(upsert(t), [userId, JSON.stringify(rows)]);
    if (gone.length) await client.query("delete from covers where user_id = $1 and id = any($2::text[])", [userId, gone]);
  });
}

/** One article's full text. */
export async function articleDoc(userId: string, id: string): Promise<unknown | null> {
  const rows = await query("select doc from articles where user_id = $1 and id = $2 and not deleted and doc is not null", [userId, id]);
  return rows.length ? rows[0].doc : null;
}

/** One statement per table: unpack the JSON array of rows and upsert them all. An article pushed without its text keeps the stored one. */
function upsert(table: Collection): string {
  const isArticles = table === "articles";
  return `insert into ${table} (user_id, id, article_id, data, deleted, updated_at${isArticles ? ", doc" : ""})
    select $1, r.id, r.article_id, r.data, r.deleted, now()${isArticles ? ", r.doc" : ""}
    from jsonb_to_recordset($2::jsonb) as r(id text, article_id text, data jsonb, deleted boolean${isArticles ? ", doc jsonb" : ""})
    on conflict (user_id, id) do update set
      article_id = excluded.article_id, data = excluded.data, deleted = excluded.deleted, updated_at = now()${
        isArticles ? ", doc = case when excluded.deleted then null else coalesce(excluded.doc, articles.doc) end" : ""
      }`;
}

/* ---------- painted covers ---------- */

export async function saveCover(userId: string, id: string, jpeg: Uint8Array): Promise<void> {
  await query(
    `insert into covers (user_id, id, jpeg) values ($1, $2, $3)
     on conflict (user_id, id) do update set jpeg = excluded.jpeg, created_at = now()`,
    [userId, id, Buffer.from(jpeg).toString("base64")]
  );
}

export async function loadCover(userId: string, id: string): Promise<Uint8Array | null> {
  const rows = await query("select jpeg from covers where user_id = $1 and id = $2", [userId, id]);
  return rows.length ? Uint8Array.from(Buffer.from(String(rows[0].jpeg), "base64")) : null;
}

/* ---------- agent tokens ---------- */

export type AgentToken = { id: string; label: string; createdAt: string; lastUsedAt: string | null };

export async function createToken(userId: string, id: string, hash: string, label: string): Promise<void> {
  await query("insert into agent_tokens (id, user_id, hash, label) values ($1, $2, $3, $4)", [id, userId, hash, label]);
}

export async function listTokens(userId: string): Promise<AgentToken[]> {
  const rows = await query("select id, label, created_at, last_used_at from agent_tokens where user_id = $1 and not revoked order by created_at desc", [userId]);
  return rows.map((r) => ({ id: String(r.id), label: String(r.label), createdAt: new Date(r.created_at as string).toISOString(), lastUsedAt: r.last_used_at ? new Date(r.last_used_at as string).toISOString() : null }));
}

export async function revokeToken(userId: string, id: string): Promise<boolean> {
  const rows = await query("update agent_tokens set revoked = true where user_id = $1 and id = $2 and not revoked returning id", [userId, id]);
  return rows.length > 0;
}

/** The reader a token belongs to, noting that it was used. Null for an unknown or revoked token. */
export async function tokenUser(hash: string): Promise<{ userId: string; label: string } | null> {
  const rows = await query("update agent_tokens set last_used_at = now() where hash = $1 and not revoked returning user_id, label", [hash]);
  return rows.length ? { userId: String(rows[0].user_id), label: String(rows[0].label ?? "") } : null;
}

/* ---------- the library, for an agent ---------- */

export type ShelfRow = { id: string; data: Record<string, unknown>; pct: number };

/** Every text on a reader's shelf, with how far they've read. */
export async function shelfOf(userId: string): Promise<ShelfRow[]> {
  const rows = await query(
    `select a.id, a.data, p.data as progress from articles a
     left join progress p on p.user_id = a.user_id and p.id = a.id and not p.deleted
     where a.user_id = $1 and not a.deleted order by a.updated_at desc`,
    [userId]
  );
  return rows.map((r) => ({ id: String(r.id), data: (r.data ?? {}) as Record<string, unknown>, pct: Number((r.progress as { pct?: number } | null)?.pct ?? 0) }));
}

/** Put one imported text on a reader's shelf, as their browser would: the next sync brings it down. */
export async function shelveForUser(userId: string, item: { id: string }, doc: unknown): Promise<void> {
  await query(
    `insert into articles (user_id, id, article_id, data, doc, deleted, updated_at) values ($1, $2, $2, $3, $4, false, now())
     on conflict (user_id, id) do update set data = excluded.data, doc = excluded.doc, deleted = false, updated_at = now()`,
    [userId, item.id, JSON.stringify(item), JSON.stringify(doc)]
  );
}
