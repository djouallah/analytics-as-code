// =============================================================================
// auth.js — AuthProvider: Rayfin Fabric SSO + a scoped OneLake SAS
// =============================================================================
// The Fabric host's sign-in, and the only place that knows about it: the page has no auth
// gate of its own, so this file draws one over it until there is a session.
//
//   const auth = createAuth();          // the gate goes up
//   await auth.signIn();                // resolves once signed in; the gate comes down
//   auth.dataAccess()  -> { baseUrl, sas, expiresOn }   (data.js reads OneLake with it)
// =============================================================================

// Keep these on the same version: jsDelivr resolves their shared deps (rayfin-auth, rayfin-lib)
// to the same module URLs, so the provider operates on the client's own Auth instance.
import { perf } from './perflog.js';

const RAYFIN_CLIENT_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-client@1.36.1/+esm";
const RAYFIN_FABRIC_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-auth-provider-fabric@1.36.1/+esm";

// --- Rayfin provider: Fabric SSO session (no second login; inside the Fabric portal iframe the
// session is handed over by postMessage). The browser never holds a storage token: the getDataSas function (rayfin/functions)
// signs a read-only OneLake SAS on the data/ folder, valid ~55 min and cached in localStorage
// across reloads, so a visitor calls the function about once an hour. Backend URL, key and Fabric coordinates come
// from the rayfin.config.json that `rayfin up` writes next to the site.
function createRayfinAuth() {
  const RENEW_MARGIN_MS = 30 * 1000;       // re-sign this long before a SAS expires
  const DATA_SAS_KEY = 'rayfin_data_sas';
  let _client = null;
  let _fabric = null;
  let _fabricOpts = null;
  let _data = load();                      // { baseUrl, sas, expiresOn } from getDataSas

  // The gate: over the whole page until the Fabric session resolves, so the dashboard is not
  // shown, even empty, before sign-in. The colours are the page's.
  const _gate = document.createElement('div');
  _gate.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;gap:1.2rem;align-items:center;justify-content:center;background:var(--bg, #0a0c10);color:var(--muted, #9aa3b2);text-align:center;padding:2rem;font-family:system-ui,sans-serif;line-height:1.55';
  _gate.textContent = 'Loading…';
  document.body.append(_gate);

  // localStorage can be unavailable (private mode, blocked storage): the cache is best-effort.
  function load() { try { return JSON.parse(localStorage.getItem(DATA_SAS_KEY)); } catch (e) { return null; } }
  function save(v) { try { v ? localStorage.setItem(DATA_SAS_KEY, JSON.stringify(v)) : localStorage.removeItem(DATA_SAS_KEY); } catch (e) {} }
  const fresh = (signed) => !!signed && Date.now() < Date.parse(signed.expiresOn) - RENEW_MARGIN_MS;

  async function init() {
    if (_client) return;
    const [{ RayfinClient, resolveRayfinConfig }, fabric] =
      await Promise.all([import(RAYFIN_CLIENT_ESM), import(RAYFIN_FABRIC_ESM)]);
    const resolved = await resolveRayfinConfig({});
    if (!resolved.baseUrl) throw new Error('rayfin.config.json not found — deploy with `rayfin up`');
    _client = new RayfinClient({ ...resolved, authStorage: true });
    const rc = _client.runtimeConfig || {};
    _fabricOpts = {
      workspaceId: rc.workspaceId,
      projectId: rc.itemId,
      fabricPortalUrl: rc.portalUrl,
      returnOrigin: window.location.origin,
    };
    _fabric = fabric;
  }

  async function dataAccess() {
    if (fresh(_data)) return _data;
    await init();
    // The function returns its failure as { error }, naming the step that failed.
    const signed = await perf.time('sas', 'getDataSas (function call)', async () => {
      const r = await _client.functions.getDataSas.invoke();
      if (r?.error) throw new Error(`getDataSas failed at ${r.error}`);
      return r;
    });
    _data = signed;
    // How long the new SAS lives (the function signs ~55 min; a stale one is re-signed on the next call).
    perf.log('info', `SAS valid ${((Date.parse(_data.expiresOn) - Date.now()) / 60000).toFixed(1)} min (expires ${_data.expiresOn})`);
    save(_data);
    return _data;
  }

  // Silent: cached data SAS / stored session / refresh token / Fabric iframe handoff.
  // Interactive (button click) adds the Fabric popup for a standalone tab.
  async function ensureSession(interactive) {
    if (!interactive && fresh(_data)) return true;
    await init();
    if (_client.auth.getSession()?.isAuthenticated) return true;
    if (interactive) return !!(await _fabric.ensureSignedInWithFabric(_client.auth, _fabricOpts))?.isAuthenticated;
    return !!(await _fabric.initEmbeddedAuth(_client.auth, _fabricOpts))?.isAuthenticated;
  }

  // Resolves once there is a session, and takes the gate down. The silent check covers a
  // cached SAS, a stored session and the Fabric iframe handoff; a standalone tab with no
  // session gets a button, because the Fabric sign-in popup needs a user gesture.
  async function signIn() {
    try {
      if (!await ensureSession(false)) await new Promise(resolve => {
        _gate.innerHTML = '<button style="padding:0.8rem 1.8rem;font:600 1rem system-ui,sans-serif;border:0;border-radius:999px;background:var(--accent, #f2f4f8);color:var(--on-accent, #0a0c10);cursor:pointer">Sign in with Fabric</button><div></div>';
        const [btn, note] = _gate.children;
        btn.onclick = async () => {
          btn.textContent = 'Signing in…';
          try {
            if (await ensureSession(true)) return resolve();
          } catch (e) { console.error(e); note.textContent = 'Sign-in failed: ' + e.message; }
          btn.textContent = 'Sign in with Fabric';
        };
      });
      _gate.remove();
    } catch (e) {
      _gate.textContent = 'Error: ' + e.message;
      throw e;
    }
  }

  return {
    signIn,
    dataAccess,
    // Drop cached SAS (e.g. after a 403) so the next call re-signs.
    async refresh() {
      _data = null;
      save(null);
      return true;
    },
  };
}

export const createAuth = createRayfinAuth;
