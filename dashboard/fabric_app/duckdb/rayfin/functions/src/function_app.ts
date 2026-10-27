import { createHmac } from 'node:crypto';

import {
  UserDataFunctions,
  AudienceType,
  type RayfinContext,
} from '@microsoft/fabric-user-data-functions';

import type { BlankAppSchema } from '../../data/schema.js';

const udf = new UserDataFunctions();

/*
 * The browser never receives a token: openFiles uses the app identity's storage token here,
 * server side, and hands back only a OneLake user-delegation SAS, read-only, on one folder of a
 * lakehouse's Files/: the .duckdb files the page downloads (the GitHub page's, written there by
 * import_data.yml). No data goes through the function.
 *
 * FILES_URL (an app setting): that folder,
 *   https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>/Files/duckdb
 * The workspace must allow "Authenticate with OneLake user-delegated SAS tokens".
 */

type StorageCtx = RayfinContext<BlankAppSchema, AudienceType.Storage>;

const ONELAKE = 'onelake.dfs.fabric.microsoft.com';
const SAS_VERSION = '2022-11-02';
const SAS_LIFETIME_MS = 55 * 60 * 1000;   // OneLake caps SAS and delegation keys at 1 hour
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface DelegationKey {
  oid: string; tid: string; start: string; expiry: string; service: string; version: string; value: string;
}

const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// FILES_URL: the folder, as https://onelake.dfs.fabric.microsoft.com/<ws>/<lh>/Files/<...>.
function filesUrl(ctx: StorageCtx): { url: string; path: string } {
  const url = ctx.Secrets.FILES_URL.trim().replace(/\/+$/, '');
  const m = url.match(/^https:\/\/onelake\.dfs\.fabric\.microsoft\.com(\/[^/]+\/[^/]+\/Files(?:\/[^/]+)+)$/);
  if (!m) throw new Error('FILES_URL is not https://onelake.dfs.fabric.microsoft.com/<workspace id>/<lakehouse id>/Files/<folder>');
  return { url, path: m[1] };
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

// User-delegation SAS query string for one folder (sr=d): /<ws>/<lh>/Files/<folder>.
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
    // Depth = folders below the workspace (container): <lh>/Files/duckdb -> 3
    sdd: String(blobPath.split('/').filter(Boolean).length - 1),
    sig,
  });
  return query.toString();
}

/**
 * A read-only SAS on the folder FILES_URL names, and the folder: the page downloads the files
 * there with it.
 * A failure is returned as { error }, naming the step: thrown, it reaches the browser as a bare
 * 500 that says nothing. The message never holds a token or a key.
 */
udf.func(
  'openFiles',
  async (ctx: RayfinContext<BlankAppSchema, AudienceType.Storage>): Promise<{
    url: string; sas: string; expiresOn: string;
  } | { error: string }> => {
    let step = 'the setting FILES_URL';
    try {
      const { url, path } = filesUrl(ctx);
      step = 'the storage token of the app identity';
      const token = ctx.Tokens.Storage;
      const { start, expiry } = sasWindow();
      step = 'the OneLake user delegation key';
      const key = await getDelegationKey(token, start, expiry);
      step = 'signing the SAS';
      const sas = signFolderSas(path, 'r', key, start, expiry);
      return { url, sas, expiresOn: iso(expiry) };
    } catch (e) {
      return { error: `${step}: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
  [],
);
