// =============================================================================
// compiler.js — nothing to compile on this host
// =============================================================================
// On the other hosts this file turns the semantic model into views and the page's DAX into
// SQL, for DuckDB. Here the engine is the semantic model itself, in Power BI, and it speaks
// DAX: the data source (../storage/data.js) sends the page's queries as they are written.
// This file stands where the compiler does only so that index.html is the same file on every
// host.
// =============================================================================

export const createModel = data => data;
