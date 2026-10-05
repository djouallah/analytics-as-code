"""Is the deployed semantic model alive: refresh it, then ask it something in DAX.

    POWERBI_TOKEN=... WS_ID=... python check_model.py

A Direct Lake model holds no data: a refresh only points it at the tables' current version,
and the query is what makes VertiPaq read them. So a row count per table, answered, says the
whole chain works: the model was published, OneLake shows it the Iceberg tables, and the
columns it names are there with the types it expects.

Every answer is printed as it came, because the first run of this is how we learn what the
catalog's tables look like to Direct Lake. Exits 1 on a refresh or a query that failed.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "https://api.powerbi.com/v1.0/myorg"
TOKEN = os.environ["POWERBI_TOKEN"]
WORKSPACE = os.environ["WS_ID"]
ITEM = Path(__file__).resolve().parent.parent / "dashboard" / "semantic" / "nem.SemanticModel"
NAME = json.loads((ITEM / ".platform").read_text(encoding="utf-8"))["metadata"]["displayName"]
TABLES = [t["name"] for t in json.loads((ITEM / "model.bim").read_text(encoding="utf-8"))["model"]["tables"]]


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


def main():
    status, body = call("GET", f"/groups/{WORKSPACE}/datasets")
    models = [d for d in (body or {}).get("value", [])] if status == 200 else []
    model = next((d for d in models if d["name"] == NAME), None)
    if not model:
        print(f"no semantic model named {NAME} in the workspace ({status}): {body}")
        return 1
    base = f"/groups/{WORKSPACE}/datasets/{model['id']}"
    print(f"model {NAME} {model['id']}, configured by {model.get('configuredBy')}")

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

    bad = 0
    for table in TABLES:
        dax = f"EVALUATE ROW(\"table\", \"{table}\", \"rows\", COUNTROWS('{table}'))"
        status, body = call("POST", f"{base}/executeQueries",
                            {"queries": [{"query": dax}], "serializerSettings": {"includeNulls": True}})
        try:
            print(f"{status} {body['results'][0]['tables'][0]['rows']}")
        except (KeyError, IndexError, TypeError):
            bad += 1
            print(f"{status} {dax}\n  {json.dumps(body)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
