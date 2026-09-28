// Postgres store: conversations and messages (every query scoped by the
// Wiki.js user id of the caller), the guest log, and the settings saved from the settings page.
//
// Connection: DATABASE_URL, or the standard PGHOST / PGUSER / PGDATABASE /
// PGPASSWORD variables; PGPASSWORD_FILE reads the password from a file (Docker secrets).

import { readFileSync } from 'node:fs';
import pg from 'pg';

const pool = new pg.Pool(process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, max: 5 }
  : {
      max: 5,
      ...(process.env.PGPASSWORD_FILE ? { password: readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim() } : {}),
    });

export async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     integer NOT NULL,
      user_email  text NOT NULL,
      title       text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS conversations_user ON conversations (user_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS messages (
      id              bigserial PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            text NOT NULL CHECK (role IN ('user', 'assistant')),
      content         text NOT NULL,
      sources         jsonb NOT NULL DEFAULT '[]',
      usage           jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages (conversation_id, id);
    -- one row per guest question that reached the model, answered or not.
    -- conversation_id groups follow-ups of one open panel; guests cannot read this back.
    CREATE TABLE IF NOT EXISTS guest_log (
      id              bigserial PRIMARY KEY,
      conversation_id uuid NOT NULL,
      ip              text NOT NULL,
      user_agent      text,
      page            text,
      question        text NOT NULL,
      answer          text,
      tools           jsonb NOT NULL DEFAULT '[]',
      sources         jsonb NOT NULL DEFAULT '[]',
      usage           jsonb,
      error           text,
      ms              integer,
      created_at      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS guest_log_conversation ON guest_log (conversation_id, id);
    CREATE INDEX IF NOT EXISTS guest_log_ip ON guest_log (ip, created_at);
    CREATE INDEX IF NOT EXISTS guest_log_created ON guest_log (created_at);
    CREATE TABLE IF NOT EXISTS settings (
      key         text PRIMARY KEY,
      value       jsonb NOT NULL,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      updated_by  text
    );
  `);
}

export async function getSettings() {
  const r = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(r.rows.map(x => [x.key, x.value]));
}

// null deletes the saved value (falls back to environment / default)
export async function saveSettings(values, by) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of Object.entries(values)) {
      if (value === null) await client.query('DELETE FROM settings WHERE key = $1', [key]);
      else await client.query(
        `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now(), updated_by = $3`,
        [key, JSON.stringify(value), by]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function stats() {
  const r = await pool.query(`
    SELECT count(DISTINCT c.id)::int AS conversations, count(m.id)::int AS messages,
           count(DISTINCT c.user_id)::int AS users,
           coalesce(sum((m.usage->>'input_tokens')::bigint), 0)::bigint AS input_tokens,
           coalesce(sum((m.usage->>'output_tokens')::bigint), 0)::bigint AS output_tokens,
           count(m.id) FILTER (WHERE m.created_at > now() - interval '7 days' AND m.role = 'assistant')::int AS answers_7d
      FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id`);
  return r.rows[0];
}

export async function listConversations(userId) {
  const r = await pool.query(
    `SELECT id, title, created_at, updated_at,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS messages
       FROM conversations c WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 200`, [userId]);
  return r.rows;
}

// null when the conversation does not exist or belongs to someone else
export async function getConversation(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const c = await pool.query('SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!c.rows.length) return null;
  const m = await pool.query('SELECT role, content, sources, created_at FROM messages WHERE conversation_id = $1 ORDER BY id', [id]);
  return { ...c.rows[0], messages: m.rows };
}

export async function createConversation(user, title, id) {
  const r = await pool.query(
    'INSERT INTO conversations (id, user_id, user_email, title) VALUES ($1, $2, $3, $4) RETURNING id, title',
    [id, user.id, user.email, title]);
  return r.rows[0];
}

// question + answer are written together, only after a successful answer
export async function appendExchange(conversationId, question, answer, sources, usage) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)', [conversationId, 'user', question]);
    await client.query('INSERT INTO messages (conversation_id, role, content, sources, usage) VALUES ($1, $2, $3, $4, $5)',
      [conversationId, 'assistant', answer, JSON.stringify(sources), JSON.stringify(usage)]);
    await client.query('UPDATE conversations SET updated_at = now() WHERE id = $1', [conversationId]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function deleteConversation(userId, id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  return r.rowCount > 0;
}

// ---------- guests ----------

// questions in the last 24 hours: from this ip, and from all guests
export async function guestCounts(ip) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE ip = $1)::int AS ip, count(*)::int AS total
       FROM guest_log WHERE created_at > now() - interval '1 day'`, [ip]);
  return r.rows[0];
}

// Answered exchanges of one guest conversation from the same ip, oldest first, as model
// messages; null when the conversation has no row from this ip (unknown id, or another ip).
export async function guestHistory(conversationId, ip, turns) {
  if (!/^[0-9a-f-]{36}$/i.test(conversationId)) return null;
  const r = await pool.query(
    `SELECT question, answer FROM guest_log WHERE conversation_id = $1 AND ip = $2
      ORDER BY id DESC LIMIT 200`, [conversationId, ip]);
  if (!r.rows.length) return null;
  return r.rows.filter(x => x.answer !== null).slice(0, turns).reverse()
    .flatMap(x => [{ role: 'user', content: x.question }, { role: 'assistant', content: x.answer }]);
}

export async function guestLogAppend(row) {
  await pool.query(
    `INSERT INTO guest_log (conversation_id, ip, user_agent, page, question, answer, tools, sources, usage, error, ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [row.conversation_id, row.ip, row.user_agent, row.page, row.question, row.answer ?? null,
      JSON.stringify(row.tools || []), JSON.stringify(row.sources || []), row.usage ? JSON.stringify(row.usage) : null,
      row.error ?? null, row.ms ?? null]);
}

export async function guestLog(limit = 100, before = null) {
  const r = await pool.query(
    `SELECT id, conversation_id, ip, user_agent, page, question, answer, tools, sources, usage, error, ms, created_at
       FROM guest_log WHERE ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $1`, [limit, before]);
  return r.rows;
}

export async function guestPrune(days) {
  const r = await pool.query(`DELETE FROM guest_log WHERE created_at < now() - make_interval(days => $1)`, [days]);
  return r.rowCount;
}

export async function guestStats() {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS guest_1d,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS guest_7d,
            count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '7 days')::int AS guest_ips_7d
       FROM guest_log`);
  return r.rows[0];
}

export function toMarkdown(conv, origin) {
  const fmt = d => new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const out = [`# ${conv.title}`, '', `${origin} · ${fmt(conv.created_at)} – ${fmt(conv.updated_at)}`, ''];
  for (const m of conv.messages) {
    if (m.role === 'user') {
      out.push('## Q', '', m.content, '');
    } else {
      out.push('## A', '', m.content.replace(/\]\(\//g, `](${origin}/`), '');
      if (m.sources?.length) {
        out.push('Sources:', ...m.sources.map(s => `- [${s.title}](${s.url || `${origin}/${s.locale}/${s.path}`})`), '');
      }
    }
  }
  return out.join('\n');
}
