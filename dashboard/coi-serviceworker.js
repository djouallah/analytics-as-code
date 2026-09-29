// Kill switch for the coi-serviceworker the dashboard used to register.
//
// It only existed to make the page cross-origin isolated for DuckDB-WASM's multi-threaded
// build, which the dashboard never actually selected (getJsDelivrBundles() doesn't offer it)
// and can't use yet: that build can't load the ICU extension (TimeZone) and can't hand an OPFS
// file handle to its pthreads. All it did was reload the page on a first visit.
//
// The page no longer registers it, but browsers that visited before still have it installed.
// Their next update check fetches this file, which replaces the old worker and unregisters it.
// Safe to delete from the repo and from build.yml's deploy step once old visitors have cycled
// through (a few months after 2026-09-30).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.registration.unregister());
