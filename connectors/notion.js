/**
 * Notion connector
 * ================
 * Reads a Notion database as rows. Notion stores every cell as a typed object
 * rather than a value, so most of this file is flattening those types back into
 * something a spreadsheet-shaped engine can average.
 *
 * Share the database with the Pulse integration (Notion: ... menu -> Connections)
 * or every request returns an empty result with no error, which is the single
 * most confusing failure mode in this whole system - so we detect it explicitly
 * below and turn it into a readable flag.
 */

import { normalizeKey } from './index.js';

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';

/** Flatten one Notion property object into a plain value. */
export function flattenProperty(prop) {
  if (!prop || typeof prop !== 'object') return null;
  switch (prop.type) {
    case 'title':
    case 'rich_text':
      return (prop[prop.type] ?? []).map((t) => t.plain_text).join('') || null;
    case 'number':   return prop.number;
    case 'checkbox': return prop.checkbox;
    case 'select':   return prop.select?.name ?? null;
    case 'status':   return prop.status?.name ?? null;
    case 'multi_select': return (prop.multi_select ?? []).map((s) => s.name).join(', ') || null;
    case 'date':     return prop.date?.start ?? null;
    case 'people':   return (prop.people ?? []).map((p) => p.name).filter(Boolean).join(', ') || null;
    case 'url':      return prop.url;
    case 'email':    return prop.email;
    case 'phone_number': return prop.phone_number;
    case 'created_time':      return prop.created_time;
    case 'last_edited_time':  return prop.last_edited_time;
    case 'formula':  return prop.formula?.[prop.formula?.type] ?? null;
    case 'rollup':
      if (prop.rollup?.type === 'number') return prop.rollup.number;
      if (prop.rollup?.type === 'array') return prop.rollup.array.map(flattenProperty).join(', ');
      return null;
    case 'relation': return (prop.relation ?? []).length; // count, the useful scalar
    case 'unique_id':
      return prop.unique_id ? `${prop.unique_id.prefix ?? ''}${prop.unique_id.number}` : null;
    default: return null;
  }
}

export async function fetchNotion(source, period, env) {
  const key = env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY not set - see .env.example');

  const headers = {
    authorization: `Bearer ${key}`,
    'notion-version': VERSION,
    'content-type': 'application/json'
  };

  // Confirm the integration can actually see the database. Without this check a
  // missing share looks identical to an empty week.
  const meta = await fetch(`${API}/databases/${source.ref}`, { headers });
  if (meta.status === 404) {
    throw new Error(
      'database not shared with the Pulse integration (open it in Notion, ... menu, Connections, add Pulse).'
    );
  }
  if (!meta.ok) throw new Error(`Notion API ${meta.status} reading the database`);

  const filter = buildPeriodFilter(source.date_column, period);
  const rows = [];
  let cursor;

  do {
    const res = await fetch(`${API}/databases/${source.ref}/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
        ...(filter ? { filter } : {})
      })
    });
    if (!res.ok) throw new Error(`Notion query failed (${res.status})`);
    const json = await res.json();

    for (const page of json.results) {
      const row = {};
      for (const [name, prop] of Object.entries(page.properties ?? {})) {
        row[normalizeKey(name)] = flattenProperty(prop);
      }
      row._id = page.id;
      row._last_edited = page.last_edited_time;
      rows.push(row);
    }
    cursor = json.has_more ? json.next_cursor : null;
  } while (cursor);

  const columns = rows.length ? Object.keys(rows[0]) : [];
  const asOf = rows.reduce(
    (max, r) => (!max || r._last_edited > max ? r._last_edited : max),
    null
  );

  return { columns, rows, asOf };
}

function buildPeriodFilter(dateColumn, period) {
  if (!dateColumn || !period?.start) return null;
  return {
    and: [
      { property: dateColumn, date: { on_or_after: period.start } },
      { property: dateColumn, date: { on_or_before: period.end } }
    ]
  };
}
