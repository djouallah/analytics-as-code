// =============================================================================
// files.js — where the .duckdb files are, and a SAS to read them, from the app's function
// =============================================================================
// The browser never holds a token: the openFiles function (rayfin/functions) signs a read-only
// SAS on the one folder of the lakehouse's Files/ that holds the files, valid ~55 min.
//
// The answer is kept in localStorage until shortly before its SAS expires, so a viewer calls
// the function about once an hour, not on every load; a page open longer gets a new one before
// the old one expires. This browser's alone: nothing is shared.
//
//   const files = createFiles(() => auth.client());
//   await files.open()        -> { url, sas, expiresOn }
//   files.url(name)           the address of a file, with the current SAS
//   files.fresh()             true while the kept answer is good: the page starts without a session
// =============================================================================

import { perf } from '../frontend/perflog.js';

const KEY = 'rayfin_files';
const RENEW_MARGIN_MS = 2 * 60 * 1000;   // ask again this long before the SAS expires

export function createFiles(client) {
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } };
  const save = v => { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} };
  const renewAt = a => a ? Date.parse(a.expiresOn) - RENEW_MARGIN_MS : 0;
  let current = null;

  async function call() {
    const rayfin = await client();
    const r = await perf.time('sas', 'openFiles', async () => {
      const r = await rayfin.functions.openFiles.invoke(undefined, { timeoutMs: 240000 });
      if (r?.error) throw new Error(`openFiles failed at ${r.error}`);
      return r;
    });
    perf.log('info', `files: ${r.url.replace(/^.*\/Files\//, 'Files/')}; SAS until ${r.expiresOn}`);
    save(r);
    return r;
  }

  // A page open longer than its SAS: a new one shortly before it expires (tried again a minute
  // later if it fails). url() reads the current one, so later downloads use it.
  function renewLater() {
    setTimeout(async () => {
      try { current = await call(); renewLater(); }
      catch (e) { perf.log('error', 'SAS renewal', { status: String(e?.message || e) }); setTimeout(renewLater, 60000); }
    }, Math.max(renewAt(current) - Date.now(), 0));
  }

  async function open() {
    const kept = load();
    if (kept && Date.now() < renewAt(kept)) {
      perf.log('info', `files: kept answer, SAS until ${kept.expiresOn}`);
      current = kept;
    } else {
      current = await call();
    }
    renewLater();
    return current;
  }

  return {
    open,
    url: name => `${current.url}/${name}?${current.sas}`,
    fresh: () => { const a = load(); return !!a && Date.now() < renewAt(a); },
  };
}
