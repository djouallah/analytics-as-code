"""Is the deployed semantic model alive: refresh it, then ask it something in DAX.

    POWERBI_TOKEN=... WS_ID=... ADOMD_DIR=... PYTHONNET_RUNTIME=coreclr python check_model.py

A Direct Lake model holds no data: a refresh only points it at the tables' current version,
and the query is what makes VertiPaq read them. So a row count per table, answered, says the
whole chain works: the model was published, OneLake shows it the Iceberg tables, and the
columns it names are there with the types it expects. Then every measure, per day, over the
newest week of fct_summary.

THE QUERIES GO OVER XMLA (ADOMD.NET, loaded through pythonnet), not the REST executeQueries
call: that call answers 401 PowerBINotAuthorizedException to a service principal on this
model, whatever its role (2026-10-05, Contributor then Admin; its reference page says
service principals are not supported on a model with single sign-on, which is how a Direct
Lake model reads OneLake). XMLA takes the same token, as the connection's password. The
owner's direct-lake-parquet-layout benchmark queries its Direct Lake models the same way.
The refresh and the two lookups stay on REST, where they work.

ADOMD_DIR is a folder holding Microsoft.AnalysisServices.AdomdClient.dll and what it needs
(deploy_model.yml makes one with `dotnet publish`).

Every answer is printed as it came. Exits 1 on a refresh or a query that failed.
"""

import glob
import json
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
ITEM = Path(__file__).resolve().parent.parent / "dashboard" / "semantic" / "nem.SemanticModel"
NAME = json.loads((ITEM / ".platform").read_text(encoding="utf-8"))["metadata"]["displayName"]
MODEL = json.loads((ITEM / "model.bim").read_text(encoding="utf-8"))["model"]
TABLES = [t["name"] for t in MODEL["tables"]]
MEASURES = [m["name"] for t in MODEL["tables"] for m in t.get("measures", [])]


def call(method, path, body=None):
    """(status, parsed body). An HTTP error is an answer too: its body says why."""
    req = urllib.request.Request(f"{API}{path}", method=method,
                                 data=None if body is None else json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, raw = e.code, e.read()
    try:
        return status, json.loads(raw) if raw else None
    except ValueError:
        return status, raw.decode(errors="replace")


def connect(workspace_name):
    """An XMLA connection to the model. The data source is the workspace's NAME, not its id."""
    import clr  # pythonnet

    hits = glob.glob(os.path.join(os.environ["ADOMD_DIR"], "**", "Microsoft.AnalysisServices.AdomdClient.dll"),
                     recursive=True)
    if not hits:
        sys.exit(f"no Microsoft.AnalysisServices.AdomdClient.dll under {os.environ['ADOMD_DIR']}")
    sys.path.append(os.path.dirname(hits[0]))
    clr.AddReference("Microsoft.AnalysisServices.AdomdClient")
    from Microsoft.AnalysisServices.AdomdClient import AdomdConnection

    conn = AdomdConnection(f"Data Source=powerbi://api.powerbi.com/v1.0/myorg/{workspace_name};"
                           f"Initial Catalog={NAME};User ID=;Password={TOKEN};")
    conn.Open()
    return conn


def query(conn, dax):
    """The rows of a DAX query, as dicts of text."""
    from Microsoft.AnalysisServices.AdomdClient import AdomdCommand

    reader = AdomdCommand(dax, conn).ExecuteReader()
    try:
        names = [reader.GetName(i) for i in range(reader.FieldCount)]
        rows = []
        while reader.Read():
            rows.append({name: str(reader.GetValue(i)) for i, name in enumerate(names)})
        return rows
    finally:
        reader.Close()


def main():
    by_id = urllib.parse.quote(f"id eq '{WORKSPACE}'")
    status, body = call("GET", f"/groups?$filter={by_id}")
    workspace_name = (body or {}).get("value", [{}])[0].get("name") if status == 200 else None
    status, body = call("GET", f"/groups/{WORKSPACE}/datasets")
    model = next((d for d in (body or {}).get("value", []) if d["name"] == NAME), None) if status == 200 else None
    if not workspace_name or not model:
        print(f"no semantic model named {NAME} in workspace {workspace_name or WORKSPACE} ({status}): {body}")
        return 1
    base = f"/groups/{WORKSPACE}/datasets/{model['id']}"
    print(f"model {NAME} {model['id']} in workspace {workspace_name}, configured by {model.get('configuredBy')}")

    status, body = call("POST", f"{base}/refreshes", {"notifyOption": "NoNotification"})
    print(f"refresh requested: {status} {body or ''}")
    if status not in (200, 202):
        return 1
    for _ in range(60):
        time.sleep(5)
        status, body = call("GET", f"{base}/refreshes?$top=1")
        last = (body or {}).get("value", [{}])[0] if status == 200 else {}
        if last.get("status") not in (None, "Unknown"):
            break
    print(f"refresh: {json.dumps(last)}")
    if last.get("status") != "Completed":
        return 1

    queries = [f"EVALUATE ROW(\"table\", \"{table}\", \"rows\", COUNTROWS('{table}'))" for table in TABLES]
    if MEASURES:
        # Every measure, per day, over the newest week the fact holds: the numbers to hold
        # against the dashboard's.
        measures = ", ".join(f'"{m}", [{m}]' for m in MEASURES)
        queries.append(f"""EVALUATE
            VAR newest = MAX(fct_summary[date])
            RETURN CALCULATETABLE(
                SUMMARIZECOLUMNS(fct_summary[date], {measures}),
                fct_summary[date] > newest - 7)
            ORDER BY fct_summary[date]""")

    conn, bad = None, 0
    for n, dax in enumerate(queries):
        # A model that was just created cannot read OneLake until its access has propagated:
        # the connection and the first query are tried again for a few minutes.
        for attempt in range(8 if n == 0 else 1):
            try:
                conn = conn or connect(workspace_name)
                for row in query(conn, dax):
                    print(json.dumps(row))
                break
            except Exception as e:  # noqa: BLE001  (a .NET exception: its text is the evidence)
                error = str(e).strip().splitlines()[0][:600] if str(e).strip() else type(e).__name__
                if n == 0 and attempt < 7:
                    print(f"not answering yet: {error}; again in 30 s", flush=True)
                    time.sleep(30)
        else:
            bad += 1
            print(f"FAILED {' '.join(dax.split())}\n  {error}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
