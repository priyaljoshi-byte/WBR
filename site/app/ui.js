/**
 * ui.js - the small shared vocabulary every page uses.
 *
 * One rule runs through all of it: an empty state says what to do next. "No data"
 * is a dead end that makes a person close the tab. "Nobody has connected the
 * India pipeline yet - paste the sheet link" is a next action.
 *
 * The other rule: everything that could have come from a file, a URL, a
 * transcript or the database goes through esc() before it reaches innerHTML.
 * Uploaded content is DATA. It never becomes markup and it never becomes an
 * instruction.
 */

export function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

/**
 * The empty state. `next` is not optional on purpose - if you cannot say what
 * the reader should do, the screen should not be empty, it should not exist.
 */
export function emptyState({ title, next, action }) {
  return `<div class="empty">
    <p class="empty-t">${esc(title)}</p>
    <p class="empty-n">${esc(next)}</p>
    ${action ? `<div class="empty-a">${action}</div>` : ''}
  </div>`;
}

export function errorState(err, what) {
  const msg = err && err.message ? err.message : String(err);
  return `<div class="empty empty-err">
    <p class="empty-t">${esc(what || 'That did not work')}</p>
    <p class="empty-n">${esc(msg)}</p>
  </div>`;
}

let toastTimer = null;
export function toast(msg, kind) {
  let node = document.getElementById('pulse-toast');
  if (!node) {
    node = el('div', { id: 'pulse-toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(node);
  }
  node.textContent = msg;
  node.className = `toast show${kind ? ` toast-${kind}` : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.className = 'toast'; }, 3600);
}

export async function copyToClipboard(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${label || 'Copied'} copied`);
    return true;
  } catch {
    toast('Could not copy - select it and press Cmd-C', 'warn');
    return false;
  }
}

/* ------------------------------ formatting -------------------------------- */

export function relativeTime(iso) {
  if (!iso) return 'never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'never';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

export const today = () => new Date().toISOString().slice(0, 10);

export function daysBack(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export const UNIT_LABELS = {
  count: 'count',
  currency_inr: 'rupees',
  currency_usd: 'dollars',
  percent: 'percent (0-1)',
  duration: 'seconds',
  duration_days: 'days'
};

/** Freshness, in words, with the weight the dashboard gives it: daily is the
 *  expected state so it stays quiet, last_minute and stale get the amber. */
export const FRESHNESS = {
  daily: { label: 'maintained daily', loud: false },
  weekly: { label: 'maintained weekly', loud: false },
  last_minute: { label: 'assembled for the meeting', loud: true },
  stale: { label: 'stale', loud: true },
  unknown: { label: 'freshness unknown', loud: false }
};

export function freshnessBadge(level) {
  const f = FRESHNESS[level] || FRESHNESS.unknown;
  return `<span class="fresh${f.loud ? ' fresh-loud' : ''}">${esc(f.label)}</span>`;
}

export function progressBar(done, total) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  return `<div class="prog" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
    <span style="width:${pct}%"></span>
  </div>`;
}

/** Read uploaded text without ever letting it reach eval, innerHTML or a prompt. */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsText(file);
  });
}

/** Turn an element into a drag-and-drop target. */
export function dropZone(node, onFiles) {
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  ['dragenter', 'dragover'].forEach((n) => node.addEventListener(n, (e) => { stop(e); node.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((n) => node.addEventListener(n, (e) => { stop(e); node.classList.remove('drag'); }));
  node.addEventListener('drop', (e) => {
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (files.length) onFiles(files);
  });
}
