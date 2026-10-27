import { createHmac } from 'node:crypto';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives a token: openCatalog uses the app identity's storage token here,
 * server side, and hands back only
 *   - where each table the page asked for is now: its current metadata.json, from the OneLake
 *     Iceberg REST catalog (loadTable), and
 *   - a OneLake user-delegation SAS, read-only, on the lakehouse's Tables/ folder: DuckDB in the
 *     browser reads the metadata, the manifests and the data files with it.
 * Nothing in it names a table: the page asks for the tables its model names.
 *
 * CATALOG_URL (an app setting): the catalog the app reads,
 *   https://onelake.table.fabric.microsoft.com/iceberg/<workspace id>/<lakehouse id>
 * The workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 */

type StorageCtx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const ONELAKE = 'onelake.dfs.fabric.microsoft.com';
const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 55 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const TABLE = /^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/;   // schema.table, the model's `source`

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// CATALOG_URL: the catalog's REST endpoint, then its warehouse, <workspace id>/<lakehouse id>,
// which is also the Tables/ folder's parent.
function catalogUrl(ctx: StorageCtx): { endpoint: string; ws: string; lh: string } {
  const m = ctx.Secrets.CATALOG_URL.trim().replace(/\/+$/, '').match(/^(https:\/\/.+)\/([^/]+)\/([^/]+)$/);
  if (!m) throw new Error('CATALOG_URL is not https://<catalog endpoint>/<workspace id>/<lakehouse id>');
  return { endpoint: m[1], ws: m[2], lh: m[3] };
}

async function getJson(url: string, token: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { error: { message: text.slice(0, 200) } }; }
  return { status: res.status, body };
}

// The catalog's prefix for the warehouse (GET /v1/config), kept while this instance is warm.
const _prefixes = new Map<string, string>();
async function catalogPrefix(endpoint: string, ws: string, lh: string, token: string): Promise<string> {
  const key = `${ws}/${lh}`;
  const cached = _prefixes.get(key);
  if (cached) return cached;
  const { status, body } = await getJson(`${endpoint}/v1/config?warehouse=${encodeURIComponent(key)}`, token);
  const prefix = body?.overrides?.prefix ?? body?.defaults?.prefix;
  if (status !== 200 || !prefix) throw new Error(`HTTP ${status} ${body?.error?.message ?? 'no prefix in the config'}`);
  _prefixes.set(key, prefix);
  return prefix;
}

// Each table's current metadata.json, all at once. A table the catalog does not have is
// `missing`: the page shows no data where it reads it, as it does for a table not deployed.
async function loadTables(endpoint: string, prefix: string, tables: string[], token: string):
    Promise<{ metadata: Record<string, string>; missing: string[] }> {
  const metadata: Record<string, string> = {};
  const missing: string[] = [];
  await Promise.all(tables.map(async t => {
    const [ns, name] = t.split('.');
    const { status, body } = await getJson(`${endpoint}/v1/${prefix}/namespaces/${ns}/tables/${name}`, token);
    if (status === 404) { missing.push(t); return; }
    const location = body?.['metadata-location'];
    if (status !== 200 || !location) throw new Error(`${t}: HTTP ${status} ${body?.error?.message ?? 'no metadata-location'}`);
    metadata[t] = location;
  }));
  return { metadata, missing: missing.sort() };
}

// Window for both the delegation key and the SAS: now-skew .. +55 min. OneLake caps the key window
// (start..expiry) at 60 min; it does NOT cap it at the requesting token's expiry (tested), so a
// nearly-expired storage token must not shorten the SAS.
function sasWindow(): { start: Date; expiry: Date } {
  const now = Date.now();
  return { start: new Date(now - CLOCK_SKEW_MS), expiry: new Date(now + SAS_LIFETIME_MS) };
}

async function getDelegationKey(token: string, start: Date, expiry: Date): Promise<DelegationKey> {
  const host = ONELAKE.replace('.dfs.', '.blob.');
  const res = await fetch(`https://${host}/?restype=service&comp=userdelegationkey`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-ms-version': SAS_VERSION, 'Content-Type': 'application/xml' },
    body: `<?xml version="1.0" encoding="utf-8"?><KeyInfo><Start>${iso(start)}</Start><Expiry>${iso(expiry)}</Expiry></KeyInfo>`,
  });
  const xml = await res.text();
  const find = (name: string): string | undefined => xml.match(new RegExp(`<${name}>([^<]*)</${name}>`))?.[1];
  // OneLake's own error code and message (an error body carries no key).
  if (!res.ok) throw new Error(`HTTP ${res.status} ${find('Code') ?? ''} ${(find('Message') ?? '').slice(0, 200)}`.trim());
  const tag = (name: string): string => {
    const v = find(name);
    if (v === undefined) throw new Error(`no ${name} in the answer (HTTP ${res.status})`);
    return v;
  };
  return {
    oid: tag('SignedOid'), tid: tag('SignedTid'), start: tag('SignedStart'), expiry: tag('SignedExpiry'),
    service: tag('SignedService'), version: tag('SignedVersion'), value: tag('Value'),
  };
}

// User-delegation SAS query string for one folder (sr=d): /<ws>/<lh>/Tables.
function signFolderSas(blobPath: string, permissions: string, key: DelegationKey, start: Date, expiry: Date): string {
  const st = iso(start);
  const se = iso(expiry);
  const stringToSign = [
    permissions, st, se, `/blob/onelake${blobPath}`,
    key.oid, key.tid, key.start, key.expiry, key.service, key.version,
    '', '', '', '',          // saoid, suoid, scid, sip (unsupported by OneLake)
    'https', SAS_VERSION, 'd',
    '', '',                  // snapshot time, encryption scope
    '', '', '', '', '',      // rscc, rscd, rsce, rscl, rsct
  ].join('\n');
  const sig = createHmac('sha256', Buffer.from(key.value, 'base64')).update(stringToSign, 'utf8').digest('base64');
  const query = new URLSearchParams({
    sp: permissions, st, se, skoid: key.oid, sktid: key.tid, skt: key.start, ske: key.expiry,
    sks: key.service, skv: key.version, spr: 'https', sv: SAS_VERSION, sr: 'd',
    // Depth = folders below the workspace (container): <lh>/Tables -> 2
    sdd: String(blobPath.split('/').filter(Boolean).length - 1),
    sig,
  });
  return query.toString();
}

/**
 * The tables the page's model names (`schema.table`, comma-separated), as they are in the
 * catalog now, and a read-only SAS on Tables/ to read them with.
 * A failure is returned as { error }, naming the step: thrown, it reaches the browser as a bare
 * 500 that says nothing. The message never holds a token or a key.
 */
udf.func(
  'openCatalog',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>, tables: string): Promise<{
    metadata: Record<string, string>; missing: string[]; sas: string; expiresOn: string; catalogMs: number;
  } | { error: string }> => {
    let step = 'the table names';
    try {
      const names = [...new Set(String(tables ?? '').split(',').map(s => s.trim()).filter(Boolean))];
      const bad = names.filter(t => !TABLE.test(t));
      if (!names.length || bad.length) throw new Error(`expected schema.table, comma-separated; got ${bad.join(', ') || 'none'}`);
      step = 'the storage token of the app identity';
      const token = ctx.Tokens.Storage;
      step = 'the setting CATALOG_URL';
      const { endpoint, ws, lh } = catalogUrl(ctx);
      const { start, expiry } = sasWindow();
      step = 'the catalog and the OneLake user delegation key';
      const t0 = Date.now();
      const [catalog, key] = await Promise.all([
        catalogPrefix(endpoint, ws, lh, token).then(prefix => loadTables(endpoint, prefix, names, token)),
        getDelegationKey(token, start, expiry),
      ]);
      const catalogMs = Date.now() - t0;
      step = 'signing the SAS';
      const sas = signFolderSas(`/${ws}/${lh}/Tables`, 'r', key, start, expiry);
      return { ...catalog, sas, expiresOn: iso(expiry), catalogMs };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);
