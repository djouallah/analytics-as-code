// =============================================================================
// auth.js — AuthProvider: Rayfin Fabric SSO
// =============================================================================
// A Fabric app's sign-in, and the only place that knows about it: the page has no auth gate
// of its own, so this file draws one over it until there is a session. Both Fabric apps use
// this file (build.mjs copies it into each); what an app does once signed in is its data.js's.
//
//   const auth = createAuth();          // the gate goes up
//   await auth.signIn();                // resolves once signed in; the gate comes down
//   await auth.client()                 // the Rayfin client of the session
//
// Two options, one per app:
//   client(rayfin, config)   builds the Rayfin client, from the SDK module and the resolved
//                            config. The default is a RayfinClient (functions); the VertiPaq
//                            app builds one with its connector.
//   ready()                  true when the app already holds what it needs and can start
//                            without a session (this app: a OneLake SAS that is still valid).
// =============================================================================

// Keep these on the same version: jsDelivr resolves their shared deps (rayfin-auth, rayfin-lib)
// to the same module URLs, so the provider operates on the client's own Auth instance.
const RAYFIN_CLIENT_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-client@1.36.1/+esm";
const RAYFIN_FABRIC_ESM = "https://cdn.jsdelivr.net/npm/@microsoft/rayfin-auth-provider-fabric@1.36.1/+esm";

// --- Rayfin provider: Fabric SSO session (no second login; inside the Fabric portal iframe the
// session is handed over by postMessage). Backend URL, key and Fabric coordinates come from the
// rayfin.config.json that `rayfin up` writes next to the site.
function createRayfinAuth({ client = (rayfin, config) => new rayfin.RayfinClient(config), ready = () => false } = {}) {
  let _client = null;
  let _fabric = null;
  let _fabricOpts = null;

  // The gate: over the whole page until the Fabric session resolves, so the dashboard is not
  // shown, even empty, before sign-in. The colours are the page's.
  const _gate = document.createElement('div');
  _gate.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;flex-direction:column;gap:1.2rem;align-items:center;justify-content:center;background:var(--bg, #0a0c10);color:var(--muted, #9aa3b2);text-align:center;padding:2rem;font-family:system-ui,sans-serif;line-height:1.55';
  _gate.textContent = 'Loading…';
  document.body.append(_gate);

  // One init, whoever asks first.
  let _init = null;
  const init = () => _init ??= (async () => {
    const [rayfin, fabric] = await Promise.all([import(RAYFIN_CLIENT_ESM), import(RAYFIN_FABRIC_ESM)]);
    const resolved = await rayfin.resolveRayfinConfig({});
    if (!resolved.baseUrl) throw new Error('rayfin.config.json not found — deploy with `rayfin up`');
    _client = await client(rayfin, { ...resolved, authStorage: true });
    const rc = _client.runtimeConfig || {};
    _fabricOpts = {
      workspaceId: rc.workspaceId,
      projectId: rc.itemId,
      fabricPortalUrl: rc.portalUrl,
      returnOrigin: window.location.origin,
    };
    _fabric = fabric;
  })().catch(e => { _init = null; throw e; });

  // Silent: what the app already holds / stored session / refresh token / Fabric iframe handoff.
  // Interactive (button click) adds the Fabric popup for a standalone tab.
  async function ensureSession(interactive) {
    if (!interactive && ready()) return true;
    await init();
    if (_client.auth.getSession()?.isAuthenticated) return true;
    if (interactive) return !!(await _fabric.ensureSignedInWithFabric(_client.auth, _fabricOpts))?.isAuthenticated;
    return !!(await _fabric.initEmbeddedAuth(_client.auth, _fabricOpts))?.isAuthenticated;
  }

  // Resolves once there is a session, and takes the gate down. The silent check covers what
  // the app already holds, a stored session and the Fabric iframe handoff; a standalone tab
  // with no session gets a button, because the Fabric sign-in popup needs a user gesture.
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

  // The client with a session: a re-sign after the cached SAS ran out (sas.js) needs one as
  // much as the first did, and the gate is down by then.
  async function signedClient() {
    await init();
    if (!_client.auth.getSession()?.isAuthenticated && !await ensureSession(false))
      throw new Error('signed out: reload the page to sign in again');
    return _client;
  }

  return { signIn, client: signedClient };
}

export const createAuth = createRayfinAuth;
