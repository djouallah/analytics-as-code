"""Read-only probe: how the OneLake Iceberg REST catalog answers loadTable, raw and from duckdb.

Dispatch probe_catalog.yml with probe=load. For every table of `landing` and `mart`: the
catalog's answer to GET .../tables/<t> (status, metadata-location, the location's host and
first path segments), then duckdb reading each table with HTTP logging on, printing every
request that did not answer 2xx (method, URL without query string, status). No write.
"""
import json
import os
import urllib.error
import urllib.request
from urllib.parse import urlsplit

import duckdb

ENDPOINT = os.environ["ONELAKE_ENDPOINT"]
WAREHOUSE = os.environ["WAREHOUSE_PATH"]
TOKEN = os.environ["ONELAKE_TOKEN"]
NAMESPACES = ["landing", "mart"]


def get(url):
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")[:500]
        return e.code, body


def shape(loc):
    if not loc:
        return loc
    p = urlsplit(loc)
    return f"{p.scheme}://{p.netloc}/{'/'.join(p.path.strip('/').split('/')[:4])}/..."


print("== config")
status, cfg = get(f"{ENDPOINT}/v1/config?warehouse={WAREHOUSE}")
print(status, json.dumps(cfg)[:800])

tables = {}
for ns in NAMESPACES:
    status, body = get(f"{ENDPOINT}/v1/{WAREHOUSE}/namespaces/{ns}/tables")
    names = [i["name"] for i in body.get("identifiers", [])] if isinstance(body, dict) else []
    print(f"== list {ns}: {status}, {len(names)} tables")
    tables[ns] = names

print("== raw loadTable")
for ns, names in tables.items():
    for t in names:
        status, body = get(f"{ENDPOINT}/v1/{WAREHOUSE}/namespaces/{ns}/tables/{t}")
        if status == 200:
            md = body.get("metadata", {})
            print(f"{ns}.{t}: 200 metadata-location={shape(body.get('metadata-location'))} "
                  f"location={shape(md.get('location'))} snapshots={len(md.get('snapshots') or [])} "
                  f"current={md.get('current-snapshot-id')}")
        else:
            print(f"{ns}.{t}: {status} {body}")

print("== duckdb")
con = duckdb.connect()
for ext in ("iceberg", "azure"):
    con.execute(f"INSTALL {ext}; LOAD {ext}")
print("duckdb", duckdb.__version__,
      con.execute("SELECT extension_name, extension_version FROM duckdb_extensions() "
                  "WHERE extension_name IN ('iceberg','azure','httpfs')").fetchall())
con.execute("SET TimeZone = 'UTC'")
con.execute(f"CREATE SECRET onelake_storage (TYPE azure, PROVIDER access_token, ACCESS_TOKEN '{TOKEN}')")
con.execute(f"ATTACH '{WAREHOUSE}' AS cat (TYPE iceberg, ENDPOINT '{ENDPOINT}', TOKEN '{TOKEN}', "
            "ACCESS_DELEGATION_MODE 'none')")
con.execute("CALL enable_logging('HTTP')")
for ns, names in tables.items():
    for t in names:
        con.execute("CALL truncate_duckdb_logs()")
        try:
            n = con.execute(f'SELECT count(*) FROM cat."{ns}"."{t}"').fetchone()[0]
            print(f"{ns}.{t}: OK {n} rows")
        except Exception as e:
            print(f"{ns}.{t}: FAIL {str(e)[:300]}")
            rows = con.execute(
                "SELECT message FROM duckdb_logs WHERE type = 'HTTP'").fetchall()
            for (m,) in rows:
                try:
                    j = json.loads(m)
                except ValueError:
                    print("   ", m[:400])
                    continue
                req, resp = j.get("request", {}), j.get("response", {})
                url = (req.get("url") or "").split("?")[0]
                code = resp.get("status") or resp.get("status_code")
                print(f"    {req.get('type')} {url} -> {code} {resp.get('reason', '')}")
