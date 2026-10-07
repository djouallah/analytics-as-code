// =============================================================================
// sas.js — a scoped OneLake SAS, from the app's function
// =============================================================================
// The browser never holds a storage token: the getDataSas function (rayfin/functions) signs a
// read-only OneLake SAS on the data/ folder, valid ~55 min and cached in localStorage across
// reloads, so a visitor calls the function about once an hour.
//
//   const sas = createSas(() => auth.client());
//   sas.dataAccess()  -> { baseUrl, sas, expiresOn }   (data.js reads OneLake with it)
//   sas.fresh()       -> true while the cached one is valid: the page can start without a
//                        session (auth.js `ready`)
// =============================================================================

import { perf } from '../frontend/perflog.js';

export function createSas(client) {
  const RENEW_MARGIN_MS = 30 * 1000;       // re-sign this long before a SAS expires
  const DATA_SAS_KEY = 'rayfin_data_sas';
  let _data = load();                      // { baseUrl, sas, expiresOn } from getDataSas

  // localStorage can be unavailable (private mode, blocked storage): the cache is best-effort.
  function load() { try { return JSON.parse(localStorage.getItem(DATA_SAS_KEY)); } catch (e) { return null; } }
  function save(v) { try { v ? localStorage.setItem(DATA_SAS_KEY, JSON.stringify(v)) : localStorage.removeItem(DATA_SAS_KEY); } catch (e) {} }
  const fresh = () => !!_data && Date.now() < Date.parse(_data.expiresOn) - RENEW_MARGIN_MS;

  // One signing at a time: every Range request of a download asks for the URL, so at the
  // renew margin they would each call the function.
  let _signing = null;
  async function dataAccess() {
    if (fresh()) return _data;
    return _signing ??= sign().finally(() => { _signing = null; });
  }
  async function sign() {
    const rayfin = await client();
    // The function returns its failure as { error }, naming the step that failed.
    const signed = await perf.time('sas', 'getDataSas (function call)', async () => {
      const r = await rayfin.functions.getDataSas.invoke();
      if (r?.error) throw new Error(`getDataSas failed at ${r.error}`);
      return r;
    });
    _data = signed;
    // How long the new SAS lives (the function signs ~55 min; a stale one is re-signed on the next call).
    perf.log('info', `SAS valid ${((Date.parse(_data.expiresOn) - Date.now()) / 60000).toFixed(1)} min (expires ${_data.expiresOn})`);
    save(_data);
    return _data;
  }

  return {
    fresh,
    dataAccess,
    // Drop cached SAS (e.g. after a 403) so the next call re-signs.
    async refresh() {
      _data = null;
      save(null);
      return true;
    },
  };
}
