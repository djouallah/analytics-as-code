import { createHmac } from 'node:crypto';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives the app identity's storage token (that token carries the owner's
 * full OneLake access). getDataSas uses it server-side and hands back a OneLake user-delegation
 * SAS that is read-only on the data/ folder (latest.json + the .duckdb files). Long-ish lifetime so
 * browsers can cache it and call this function about once an hour, not per request.
 *
 * ONELAKE_FILES_URL (rayfin secret): https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>.Lakehouse/Files
 * The data workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 */

type StorageCtx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 55 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function filesBase(ctx: StorageCtx): URL {
  return new URL(ctx.Secrets.ONELAKE_FILES_URL.replace(/\/+$/, ''));
}

// Window for both the delegation key and the SAS: now-skew .. +55 min. OneLake caps the key window
// (start..expiry) at 60 min; it does NOT cap it at the requesting token's expiry (tested), so a
// nearly-expired storage token must not shorten the SAS.
function sasWindow(): { start: Date; expiry: Date } {
  const now = Date.now();
  return { start: new Date(now - CLOCK_SKEW_MS), expiry: new Date(now + SAS_LIFETIME_MS) };
}

async function getDelegationKey(base: URL, token: string, start: Date, expiry: Date): Promise<DelegationKey> {
  const host = base.host.replace('.dfs.', '.blob.');
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

// User-delegation SAS query string for one folder (sr=d) under the Files base.
function signFolderSas(base: URL, relPath: string, permissions: string, key: DelegationKey, start: Date, expiry: Date): string {
  const blobPath = decodeURIComponent(`${base.pathname}/${relPath}`);
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
    // Depth = folders below the workspace (container), e.g. <lh>.Lakehouse/Files/data -> 3
    sdd: String(blobPath.split('/').filter(Boolean).length - 1),
    sig,
  });
  return query.toString();
}

/**
 * Read-only SAS for the data/ folder: the browser reads data/latest.json and the .duckdb files with it.
 * A failure is returned as { error }, naming the step: thrown, it reaches the browser as a bare
 * 500 that says nothing. The message never holds a token or a key.
 */
udf.func(
  'getDataSas',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>): Promise<{ baseUrl: string; sas: string; expiresOn: string } | { error: string }> => {
    let step = 'the storage token of the app identity';
    try {
      const token = ctx.Tokens.Storage;
      step = 'the secret ONELAKE_FILES_URL';
      const base = filesBase(ctx);
      step = 'the OneLake user delegation key';
      const { start, expiry } = sasWindow();
      const key = await getDelegationKey(base, token, start, expiry);
      step = 'signing the SAS';
      return { baseUrl: `${base}/data`, sas: signFolderSas(base, 'data', 'r', key, start, expiry), expiresOn: iso(expiry) };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);
