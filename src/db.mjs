// Postgres store: conversations and messages (every query scoped by the
// Wiki.js user id of the caller) plus the settings saved from the settings page.
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

export async function createConversation(user, title) {
  const r = await pool.query(
    'INSERT INTO conversations (user_id, user_email, title) VALUES ($1, $2, $3) RETURNING id, title',
    [user.id, user.email, title]);
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
