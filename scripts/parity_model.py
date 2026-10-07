"""The page's queries on the deployed model, against the same queries on the deployed files.

    python parity_model.py <parity.json>

<parity.json> is what scripts/parity/page_queries.mjs wrote: every query the page sends,
as the compiler wrote its DAX, with the rows the compiler's SQL returned on the deployed
.duckdb files. Each DAX is asked of the deployed model as it is, and its rows are held
against those: same rows, matched on the query's columns, and the same values, to a cent
or one part in a million (fct_summary keeps MW to 4 decimals, and VertiPaq computes in
fixed decimal what DuckDB computes in doubles: 30 days of emissions in SA, 88,275 t, came out
0.035 t apart). That is the test that the compiler's SQL means what the
model's DAX means, for what the page asks: the model is the reference, the compiler is the
copy.

Where the queries go: over XMLA when ADOMD_DIR is set (scripts/check_model.py's connection,
what CI uses: Power BI's REST executeQueries answers 401 to a service principal on this
model), else over REST executeQueries with POWERBI_TOKEN (a user's token, from a laptop:
`az account get-access-token --resource https://analysis.windows.net/powerbi/api`).
Both need WS_ID, the workspace of the model.

A query the compiler could not translate, or whose SQL failed, is a failure. A query whose
result was too big to keep is not asked of the model, only listed with its row count:
computing it, even under COUNTROWS, throttled the capacity (20 s on every query after it).
Exits 1 on any difference.
"""

import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

API = "https://api.powerbi.com/v1.0/myorg"
TOKEN = os.environ["POWERBI_TOKEN"]
WORKSPACE = os.environ["WS_ID"]
ITEM = Path(__file__).resolve().parent.parent / "semantic_model"
NAME = json.loads((ITEM / ".platform").read_text(encoding="utf-8"))["metadata"]["displayName"]
CENT = 0.01


def call(method, path, body=None):
    req = urllib.request.Request(f"{API}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read() or "null")


def asker():
    """A function DAX -> rows (dicts by the page's names), over XMLA or REST."""
    groups = call("GET", f"/groups?$filter={urllib.parse.quote(f'id eq {chr(39)}{WORKSPACE}{chr(39)}')}")["value"]
    if os.environ.get("ADOMD_DIR"):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import check_model
        conn = check_model.connect(groups[0]["name"])
        return lambda dax: check_model.query(conn, dax)
    model = next(d for d in call("GET", f"/groups/{WORKSPACE}/datasets")["value"] if d["name"] == NAME)

    def ask(dax):
        # A dropped connection is asked again; an answer of the model, even an error, is not.
        for attempt in range(3):
            try:
                out = call("POST", f"/groups/{WORKSPACE}/datasets/{model['id']}/executeQueries",
                           {"queries": [{"query": dax}], "serializerSettings": {"includeNulls": True}})
                return out["results"][0]["tables"][0]["rows"]
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, ConnectionError):
                if attempt == 2:
                    raise
                time.sleep(5)
    return ask


def value(v):
    """One value as both engines can be compared on: a number as a float, a blank as None, a
    date at midnight as its day, a boolean as a bool."""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v)
    if s in ("True", "true"):
        return True
    if s in ("False", "false"):
        return False
    for midnight in ("T00:00:00", " 00:00:00"):
        if len(s) >= 19 and s[10:19] == midnight:
            return s[:10]
    try:
        return float(s)
    except ValueError:
        return s


def rows_of(rows):
    """Rows by the page's names: the model names a column [name]."""
    return [{k.strip("[]").split("[")[-1]: value(v) for k, v in r.items()} for r in rows]


def same(a, b):
    if isinstance(a, float) and isinstance(b, float):
        return math.isclose(a, b, rel_tol=1e-6, abs_tol=CENT)
    return a == b


def compare(q, model_rows):
    """The differences between the files' rows and the model's, as lines of text."""
    files = rows_of(q["rows"])
    model = rows_of(model_rows)
    key = lambda r: tuple(str(r.get(k)) for k in q["keys"])
    by_key = {}
    for r in model:
        by_key.setdefault(key(r), []).append(r)
    out = []
    if len(files) != len(model):
        out.append(f"{len(files)} rows in the files, {len(model)} in the model")
    for r in files:
        hits = by_key.get(key(r))
        if not hits:
            out.append(f"only in the files: {r}")
            continue
        m = hits.pop(0)
        bad = {k: (r[k], m.get(k)) for k in r if not same(r[k], m.get(k))}
        if bad:
            out.append(f"{dict(zip(q['keys'], key(r)))}: " + ", ".join(f"{k} files {a} model {b}" for k, (a, b) in bad.items()))
    out += [f"only in the model: {m}" for ms in by_key.values() for m in ms]
    return out


def main():
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    ask = asker()
    bad = skipped = 0
    started = time.monotonic()
    for n, q in enumerate(data["queries"]):
        where = f"[{n}] {q['name']} ({'; '.join(q['states'][:3])}{', ...' if len(q['states']) > 3 else ''})"
        if q.get("error"):
            bad += 1
            print(f"FAILED {where}: the compiler or DuckDB: {q['error']}\n  {q['dax']}")
            continue
        if "rowCount" in q:
            skipped += 1
            print(f"not asked {where}, {q['rowCount']} rows in the files", flush=True)
            continue
        t = time.monotonic()
        try:
            model_rows = ask(q["dax"])
        except Exception as e:  # noqa: BLE001  (the model's answer is the evidence)
            bad += 1
            body = e.read().decode(errors="replace")[:600] if isinstance(e, urllib.error.HTTPError) else str(e)[:600]
            print(f"FAILED {where}: the model: {body}\n  {q['dax']}")
            continue
        took = time.monotonic() - t
        diffs = compare(q, model_rows)
        if diffs:
            bad += 1
            print(f"DIFFERS {where}, {took:.1f} s: {len(diffs)} differences")
            for d in diffs[:8]:
                print(f"  {d}")
            print(f"  {q['dax']}")
        else:
            print(f"same    {where}, {len(model_rows)} rows, {took:.1f} s", flush=True)
    print(f"{len(data['queries'])} queries, {bad} failed or differ, {skipped} not asked, {time.monotonic() - started:.0f} s; "
          f"files to {data['newest']}, states end {data['to']}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
