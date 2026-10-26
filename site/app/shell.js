/**
 * shell.js - sign-in, the nav bar, and who you are.
 *
 * The sign-in is the one already running in shopos-org-KPIs: Google Identity
 * Services, a hosted-domain check, a session in localStorage. Same Google client
 * id, same Supabase project, so nobody gets a second login.
 *
 * One addition on top of that pattern: the Google ID token is traded for a real
 * Supabase session (see supabase.js). The browser-side check is a door lock; the
 * Supabase JWT is what Row Level Security actually reads, and RLS is the gate
 * that decides whether a write lands. A page that hides a button is a courtesy.
 *
 * Nothing here ever shows a blank page. Signed out, offline, or with the schema
 * not yet installed, every screen still renders its chrome and says what to do.
 */

import { PULSE_CONFIG } from './config.js';
import { db, signInWithGoogleIdToken, signOut as sbSignOut, clearToken, hasToken } from './supabase.js';
import { esc, el, emptyState, toast } from './ui.js';

const SESSION_KEY = 'pulse-session';
const OPEN_NAME_KEY = 'pulse-open-name';

const PAGES = [
  { id: 'index', href: 'index.html', label: 'Setup' },
  { id: 'sources', href: 'sources.html', label: 'Sources' },
  { id: 'metrics', href: 'metrics.html', label: 'Metrics' },
  { id: 'targets', href: 'targets.html', label: 'Targets' },
  { id: 'rag', href: 'rag.html', label: 'Brand status' },
  { id: 'transcripts', href: 'transcripts.html', label: 'Add a meeting' }
];

/* -------------------------------- session --------------------------------- */

function b64urlDecode(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return decodeURIComponent(atob(s).split('').map((c) => `%${`00${c.charCodeAt(0).toString(16)}`.slice(-2)}`).join(''));
}

export function decodeJwt(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try { return JSON.parse(b64urlDecode(parts[1])); } catch { return null; }
}

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.email || Date.now() > s.expiresAt) { localStorage.removeItem(SESSION_KEY); return null; }
    return s;
  } catch { return null; }
}

function setSession(payload) {
  const days = PULSE_CONFIG.SESSION_DAYS || 7;
  const session = {
    email: payload.email,
    name: payload.name || payload.email,
    picture: payload.picture || '',
    expiresAt: Date.now() + days * 24 * 60 * 60 * 1000
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private mode */ }
  return session;
}

function emailAllowed(payload) {
  const email = String(payload.email || '').toLowerCase();
  const allow = (PULSE_CONFIG.ALLOWED_EMAILS || []).map((e) => e.toLowerCase());
  if (allow.includes(email)) return true;
  const domain = (PULSE_CONFIG.ALLOWED_HOSTED_DOMAIN || '').toLowerCase();
  if (!domain) return true;
  if (payload.hd && String(payload.hd).toLowerCase() === domain) return true;
  return email.endsWith(`@${domain}`);
}

export function signOut() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  clearToken();
  try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch { /* ignore */ }
  sbSignOut().finally(() => location.replace('index.html'));
}

/* ------------------------------- open mode -------------------------------- */

/**
 * With no sign-in there is no verified email, but several tables record who
 * entered a number (entered_by is NOT NULL). So open mode asks for a name once
 * and keeps it in this browser. It is a label, not an identity - anyone can
 * type anything - which is exactly why open mode is for setup day only.
 */
export function getOpenName() {
  try { return (localStorage.getItem(OPEN_NAME_KEY) || '').trim(); } catch { return ''; }
}

function setOpenName(name) {
  try { localStorage.setItem(OPEN_NAME_KEY, String(name || '').trim()); } catch { /* private mode */ }
}

function openModeBanner() {
  const name = getOpenName();
  const node = banner('preview', `<b>Open mode.</b> No sign-in yet - everything you save goes to the shared team database, and anyone with this link can edit it.
    <span id="pulse-openname">${name
    ? `Saving as <b>${esc(name)}</b>. <a href="#" id="pulse-rename">Change</a>`
    : `<label for="pulse-namein">Your name, so entries say who made them:</label>
       <input id="pulse-namein" type="text" autocomplete="name" placeholder="e.g. Subham" style="margin:0 6px;max-width:180px">
       <button type="button" class="btn btn-sm" id="pulse-nameok">Save</button>`}</span>`);
  const ok = node.querySelector('#pulse-nameok');
  if (ok) {
    const input = node.querySelector('#pulse-namein');
    const save = () => {
      if (!input.value.trim()) { toast('Type a name first.', 'warn'); return; }
      setOpenName(input.value);
      location.reload();
    };
    ok.addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }
  const again = node.querySelector('#pulse-rename');
  if (again) again.addEventListener('click', (e) => { e.preventDefault(); setOpenName(''); location.reload(); });
}

/* --------------------------------- role ----------------------------------- */

/**
 * viewer / owner / admin, straight out of pulse_roles. The browser copy is for
 * showing the right screen; the database copy is what actually decides a write.
 */
async function loadRole(email) {
  const fallback = { role: 'viewer', deptIds: [], isAdmin: false, source: 'default', error: null };
  if (!email || !hasToken()) return { ...fallback, source: 'signed-out' };
  try {
    const rows = await db.select('pulse_roles', { eq: { email } });
    if (!rows.length) return { ...fallback, source: 'not-on-roster' };
    const row = rows[0];
    return {
      role: row.role,
      deptIds: row.dept_ids || [],
      isAdmin: row.role === 'admin',
      source: 'database',
      error: null
    };
  } catch (err) {
    return { ...fallback, source: 'unreachable', error: err.message };
  }
}

/* ---------------------------------- nav ----------------------------------- */

function initials(name) {
  return String(name || '?').split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]).join('').toUpperCase();
}

function renderNav(active, ctx) {
  let mount = document.getElementById('navmount');
  if (!mount) {
    mount = el('div', { id: 'navmount' });
    document.body.insertBefore(mount, document.body.firstChild);
  }
  const links = PAGES.map((p) => (
    `<li><a href="${p.href}"${p.id === active ? ' aria-current="true"' : ''}>${esc(p.label)}</a></li>`
  )).join('');

  const who = ctx.openMode
    ? `<span class="when">${esc(ctx.session.name)} &middot; open mode</span>`
    : ctx.signedIn
    ? `<div class="whochip" title="${esc(ctx.session.email)}">
         ${ctx.session.picture
           ? `<img src="${esc(ctx.session.picture)}" alt="" referrerpolicy="no-referrer">`
           : `<span class="initial">${esc(initials(ctx.session.name))}</span>`}
         <span class="who-n">${esc(ctx.session.name)}</span>
         <span class="who-r">${esc(ctx.roleLine)}</span>
       </div>
       <button type="button" class="btn btn-quiet" id="pulse-signout">Sign out</button>`
    : `<span class="when">not signed in</span>`;

  mount.innerHTML = `<nav class="nav">
    <a class="brand" href="index.html">
      <span class="dot3"><i style="background:#ff375f"></i><i style="background:#c6f432"></i><i style="background:#3ddbff"></i></span>
      <b>Pulse</b><span>setup</span>
    </a>
    <ul>${links}</ul>
    <div class="nav-right">${who}</div>
  </nav>`;

  const out = document.getElementById('pulse-signout');
  if (out) out.addEventListener('click', signOut);
}

/* ------------------------------- sign-in ---------------------------------- */

function loadGsi() {
  if (window.google && window.google.accounts) return Promise.resolve(true);
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  });
}

async function onCredential(response) {
  const payload = decodeJwt(response && response.credential);
  if (!payload) { toast('That sign-in could not be read. Try again.', 'warn'); return; }
  if (!emailAllowed(payload)) {
    toast(`${payload.email} is not a ${PULSE_CONFIG.ALLOWED_HOSTED_DOMAIN} account.`, 'warn');
    return;
  }
  setSession(payload);
  try {
    await signInWithGoogleIdToken(response.credential);
  } catch (err) {
    // The door lock held but the vault did not open. Say which, rather than
    // letting every later write fail with a mystery 401.
    toast(err.message, 'warn');
  }
  location.reload();
}

/**
 * The gate. Renders the page's own explanation above the button, so a signed-out
 * visitor still learns what the screen is for instead of meeting a wall.
 */
async function renderGate(mount, { title, blurb }) {
  mount.innerHTML = `<div class="gate">
    <h2>${esc(title)}</h2>
    <p>${esc(blurb)}</p>
    <div id="gsi-button" class="gsi"></div>
    <p class="gate-note">Sign in with your ${esc(PULSE_CONFIG.ALLOWED_HOSTED_DOMAIN)} Google account. Same login as the org chart.</p>
    <p class="gate-note"><a href="?preview=1">Look around without signing in</a> - nothing can be saved in preview.</p>
  </div>`;

  const okGsi = await loadGsi();
  const host = document.getElementById('gsi-button');
  if (!okGsi || !window.google || !google.accounts || !google.accounts.id) {
    host.innerHTML = `<p class="gate-warn">Google sign-in could not load. Check the connection, or that this address is an authorised origin for the OAuth client.</p>`;
    return;
  }
  try {
    google.accounts.id.initialize({
      client_id: PULSE_CONFIG.GOOGLE_CLIENT_ID,
      callback: onCredential,
      hosted_domain: PULSE_CONFIG.ALLOWED_HOSTED_DOMAIN || undefined,
      auto_select: false
    });
    google.accounts.id.renderButton(host, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with' });
  } catch (err) {
    host.innerHTML = `<p class="gate-warn">${esc(err.message)}</p>`;
  }
}

/* --------------------------------- boot ----------------------------------- */

/**
 * @typedef {Object} Ctx
 * @property {Object|null} session
 * @property {boolean} signedIn
 * @property {boolean} preview       looking around without signing in
 * @property {'viewer'|'owner'|'admin'} role
 * @property {string[]} deptIds      the departments this person may write
 * @property {boolean} isAdmin
 * @property {string} roleLine       "Owner - India Sales", for the nav
 * @property {(deptId:string)=>boolean} canWrite
 * @property {(opts)=>boolean} guard paints the sign-in gate and returns false when signed out
 */

/**
 * Call once at the top of every page.
 * @param {{active:string, title:string, blurb:string}} opts
 * @returns {Promise<Ctx>}
 */
export async function boot(opts) {
  if (PULSE_CONFIG.OPEN_MODE) return bootOpen();
  const params = new URLSearchParams(location.search);
  const preview = params.get('preview') === '1';
  const session = getSession();
  const signedIn = !!session;

  const role = signedIn ? await loadRole(session.email) : { role: 'viewer', deptIds: [], isAdmin: false, source: 'signed-out', error: null };

  const ctx = {
    session,
    signedIn,
    preview,
    role: role.role,
    deptIds: role.deptIds,
    isAdmin: role.isAdmin,
    roleSource: role.source,
    roleError: role.error,
    roleLine: '',
    canWrite: (deptId) => role.isAdmin || (role.role === 'owner' && role.deptIds.includes(deptId)),
    /** Departments this person is responsible for. Admins see everything. */
    scope: (allDeptIds) => (role.isAdmin || !role.deptIds.length ? allDeptIds : allDeptIds.filter((d) => role.deptIds.includes(d))),
    guard: () => true
  };

  ctx.guard = (mountSelector) => {
    if (signedIn) return true;
    const mount = document.querySelector(mountSelector || '#main');
    if (!mount) return false;
    if (preview) {
      // Into #bannermount, not #main - the page is about to replace #main's
      // contents with its own render and would wipe this out.
      const host = document.getElementById('bannermount') || mount;
      host.insertAdjacentHTML('afterbegin',
        `<div class="banner banner-preview"><b>Preview.</b> You are not signed in, so nothing on this page can be saved and the numbers shown are the seed values from config/. <a href="${location.pathname}">Sign in</a></div>`);
      return true;
    }
    renderGate(mount, opts);
    return false;
  };

  return ctx;
}

/**
 * Open mode: everyone is treated as an admin, because the database (not this
 * page) is what decides what an anonymous write may touch.
 */
function bootOpen() {
  const name = getOpenName();
  const who = name || 'unnamed (open mode)';
  return {
    session: { email: who, name: name || 'Guest', picture: '' },
    signedIn: true,
    openMode: true,
    preview: false,
    role: 'admin',
    deptIds: [],
    isAdmin: true,
    roleSource: 'open',
    roleError: null,
    roleLine: 'open mode',
    canWrite: () => true,
    scope: (allDeptIds) => allDeptIds,
    guard: () => true
  };
}

/** Finishes the shell once the page knows which departments it is showing. */
export function paintShell(ctx, { active, deptLabels }) {
  if (ctx.openMode) {
    renderNav(active, ctx);
    openModeBanner();
    return;
  }
  if (ctx.signedIn) {
    const scope = ctx.isAdmin
      ? 'all departments'
      : (deptLabels && deptLabels.length ? deptLabels.join(', ') : 'no department yet');
    ctx.roleLine = `${ctx.role}${ctx.role === 'admin' ? '' : ` - ${scope}`}`;
  }
  renderNav(active, ctx);

  if (ctx.signedIn && ctx.roleSource === 'not-on-roster') {
    banner('warn', `${ctx.session.email} is signed in but is not on the Pulse roster, so you can read but not save. An admin adds you with one row in pulse_roles.`);
  } else if (ctx.signedIn && ctx.roleSource === 'unreachable') {
    banner('warn', `Signed in, but Supabase did not answer: ${ctx.roleError}. The page below is the seed from config/ and nothing can be saved yet.`);
  }
}

export function banner(kind, html) {
  const mount = document.getElementById('bannermount') || document.body;
  const node = el('div', { class: `banner banner-${kind}`, html });
  mount.insertBefore(node, mount.firstChild);
  return node;
}

/** The hard guard, for anything that must not render at all when signed out. */
export function requireAuth() {
  const s = getSession();
  if (!s) {
    const here = location.pathname.split('/').pop() || 'index.html';
    location.replace(`index.html?redirect=${encodeURIComponent(here)}`);
    return null;
  }
  return s;
}

export { PAGES };
