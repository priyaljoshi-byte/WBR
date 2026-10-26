/**
 * supabase.js - PostgREST over fetch. No SDK, no bundler, no npm.
 *
 * The Supabase JS client is ~40kB of machinery for things this app does not do.
 * What it actually needs is: swap a Google id token for a Supabase session,
 * then send six HTTP verbs with two headers. That is this file.
 *
 * Two rules it keeps:
 *   1. The anon key alone never authorises a write. Every request carries the
 *      signed-in user's access token, and RLS decides. A 401/403 coming back is
 *      the system working, so those are surfaced as readable sentences rather
 *      than swallowed.
 *   2. Nothing here caches a token anywhere a different origin could read it.
 */

import { PULSE_CONFIG } from './config.js';

const TOKEN_KEY = 'pulse-sb-session';

/* ------------------------------- session ---------------------------------- */

function readToken() {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.access_token) return null;
    if (s.expires_at && Date.now() > s.expires_at - 30000) return s; // let refresh handle it
    return s;
  } catch { return null; }
}

function writeToken(session) {
  if (!session || !session.access_token) return null;
  const stored = {
    access_token: session.access_token,
    refresh_token: session.refresh_token || null,
    expires_at: Date.now() + (session.expires_in ? session.expires_in * 1000 : 3600 * 1000),
    email: (session.user && session.user.email) || null
  };
  try { localStorage.setItem(TOKEN_KEY, JSON.stringify(stored)); } catch { /* private mode */ }
  return stored;
}

export function clearToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

export function hasToken() { return !!readToken(); }
export function tokenEmail() { const t = readToken(); return t && t.email; }

/**
 * Trade the Google ID token for a real Supabase session, so RLS sees a verified
 * `auth.jwt() ->> 'email'` instead of trusting the browser.
 * This is `signInWithIdToken` in the SDK, spelled out.
 */
export async function signInWithGoogleIdToken(idToken) {
  const res = await fetch(`${PULSE_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=id_token`, {
    method: 'POST',
    headers: { apikey: PULSE_CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', id_token: idToken })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = body.error_description || body.msg || body.error || `HTTP ${res.status}`;
    throw new Error(`Supabase would not accept the Google sign-in: ${why}`);
  }
  return writeToken(body);
}

async function refresh() {
  const t = readToken();
  if (!t || !t.refresh_token) return null;
  const res = await fetch(`${PULSE_CONFIG.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: PULSE_CONFIG.SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: t.refresh_token })
  });
  if (!res.ok) { clearToken(); return null; }
  return writeToken(await res.json());
}

export async function signOut() {
  const t = readToken();
  clearToken();
  if (!t) return;
  try {
    await fetch(`${PULSE_CONFIG.SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { apikey: PULSE_CONFIG.SUPABASE_ANON_KEY, Authorization: `Bearer ${t.access_token}` }
    });
  } catch { /* signing out locally is what matters */ }
}

/* ------------------------------- PostgREST -------------------------------- */

export class SupabaseError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'SupabaseError';
    this.status = status;
    this.detail = detail;
  }
}

/** Turn PostgREST's error shape into something a department head can read. */
function explain(status, body, table) {
  const code = body && body.code;
  const msg = (body && (body.message || body.hint || body.details)) || `HTTP ${status}`;
  if (status === 401) return `You are signed out. Sign in again to read ${table}.`;
  if (status === 403 || code === '42501') {
    return `Your account is not allowed to change ${table}. Department owners can write their own department; ask an admin for anything else.`;
  }
  if (status === 404) return `${table} does not exist yet. Run supabase/schema.sql and supabase/schema-app.sql.`;
  if (status === 409) return `That row already exists in ${table}.`;
  if (status === 0) return `Could not reach Supabase. Check the connection.`;
  return msg;
}

async function request(method, path, { body, headers, retry = true } = {}) {
  const t = readToken();
  const url = `${PULSE_CONFIG.SUPABASE_URL}/rest/v1/${path}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.assign({
        apikey: PULSE_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${(t && t.access_token) || PULSE_CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }, headers || {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new SupabaseError('Could not reach Supabase. You may be offline.', 0, String(err));
  }

  if (res.status === 401 && retry && t && t.refresh_token) {
    const fresh = await refresh();
    if (fresh) return request(method, path, { body, headers, retry: false });
  }

  const text = await res.text();
  let payload = null;
  if (text) { try { payload = JSON.parse(text); } catch { payload = text; } }

  if (!res.ok) {
    const table = String(path).split('?')[0];
    throw new SupabaseError(explain(res.status, payload, table), res.status, payload);
  }
  return payload;
}

/** `{eq:{a:1}, in:{b:[1,2]}, order:'x.desc', limit:10, select:'*'}` -> query string. */
function query(opts = {}) {
  const p = new URLSearchParams();
  p.set('select', opts.select || '*');
  for (const [col, val] of Object.entries(opts.eq || {})) p.append(col, `eq.${val}`);
  for (const [col, vals] of Object.entries(opts.in || {})) p.append(col, `in.(${vals.join(',')})`);
  for (const [col, val] of Object.entries(opts.gte || {})) p.append(col, `gte.${val}`);
  for (const [col, val] of Object.entries(opts.lte || {})) p.append(col, `lte.${val}`);
  for (const [col, val] of Object.entries(opts.neq || {})) p.append(col, `neq.${val}`);
  if (opts.isNull) for (const col of [].concat(opts.isNull)) p.append(col, 'is.null');
  if (opts.order) p.set('order', opts.order);
  if (opts.limit) p.set('limit', String(opts.limit));
  return p.toString();
}

export const db = {
  async select(table, opts = {}) {
    const rows = await request('GET', `${table}?${query(opts)}`);
    return Array.isArray(rows) ? rows : [];
  },
  insert(table, rows) {
    return request('POST', `${table}?select=*`, {
      body: rows, headers: { Prefer: 'return=representation' }
    });
  },
  upsert(table, rows, onConflict) {
    const q = onConflict ? `${table}?on_conflict=${onConflict}&select=*` : `${table}?select=*`;
    return request('POST', q, {
      body: rows, headers: { Prefer: 'resolution=merge-duplicates,return=representation' }
    });
  },
  update(table, patch, opts = {}) {
    return request('PATCH', `${table}?${query(opts)}`, {
      body: patch, headers: { Prefer: 'return=representation' }
    });
  },
  remove(table, opts = {}) {
    return request('DELETE', `${table}?${query(opts)}`);
  },
  /** Call a Supabase Edge Function. Used only for transcript extraction. */
  async fn(name, payload) {
    const t = readToken();
    const res = await fetch(`${PULSE_CONFIG.SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        apikey: PULSE_CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${(t && t.access_token) || PULSE_CONFIG.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const text = await res.text();
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch { body = text; } }
    if (!res.ok) {
      const why = (body && (body.error || body.message)) || `HTTP ${res.status}`;
      throw new SupabaseError(`The ${name} function failed: ${why}`, res.status, body);
    }
    return body;
  }
};

/** True when a table simply has not been created yet, which during setup is
 *  normal rather than an error worth shouting about. */
export const isMissingTable = (err) => err instanceof SupabaseError && (err.status === 404 || (err.detail && err.detail.code === '42P01'));

export default db;
