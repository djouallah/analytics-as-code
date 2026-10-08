"""Publish the dashboard's .duckdb files to the Fabric app's lakehouse (OneLake).

    python deploy_onelake.py

The counterpart of deploy_pages.sh for the Fabric app (dashboard/fabric_app/wasm/), which reads the same files
from OneLake instead of GitHub Pages. Run after cache_catalog.py's builds with
ALL_PERIODS=true.

    mart_dim.duckdb                  ->  dim_<ts>.duckdb
    mart_today.duckdb                ->  today_<ts>.duckdb
    mart_agg.duckdb                  ->  agg_<ts>.duckdb
    mart_<YYYY>_h<N>.duckdb          ->  <YYYY>_h<N>_<ts>.duckdb
    latest.json                          {"ts": "<ts>", "periods": ["<YYYY>_h<N>", ...]}

The files are immutable and named by timestamp, and two versions are kept: a page opened
before this run still reads the previous one.
"""

import glob
import json
import os
import re
import urllib.request
from datetime import datetime, timezone

from azure.identity import ClientAssertionCredential
from azure.storage.filedatalake import DataLakeServiceClient

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "mart_data")
# Where the app reads: workspace `app`, lakehouse `data`, in another tenant than the catalog's.
LAKE = "https://onelake.dfs.fabric.microsoft.com"
WORKSPACE, FOLDER = "app", "data.Lakehouse/Files/data"
FILES = {
    "dim": "mart_dim.duckdb",
    "today": "mart_today.duckdb",
    "agg": "mart_agg.duckdb",
}


# No secret. The job's GitHub identity token (OIDC) is exchanged for a OneLake token in the
# app's tenant: LAKE_CLIENT_ID is an app registration there that trusts this repo's main
# branch (a federated credential). It is not the azure/login of the workflow, which is the
# catalog's tenant. azure-identity asks for a new GitHub token whenever it needs a new Azure
# one.
def github_token():
    request = urllib.request.Request(
        os.environ["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=api://AzureADTokenExchange",
        headers={"Authorization": "bearer " + os.environ["ACTIONS_ID_TOKEN_REQUEST_TOKEN"]})
    with urllib.request.urlopen(request) as r:
        return json.load(r)["value"]


def publish():
    credential = ClientAssertionCredential(
        os.environ["LAKE_TENANT_ID"], os.environ["LAKE_CLIENT_ID"], github_token)
    lake = DataLakeServiceClient(LAKE, credential=credential).get_file_system_client(WORKSPACE)

    def lake_file(name):
        return lake.get_file_client(f"{FOLDER}/{name}")

    # The half-year files of the 5-minute history, as built.
    periods = sorted(re.fullmatch(r"mart_(\d{4}_h[12])\.duckdb", os.path.basename(p)).group(1)
                     for p in glob.glob(os.path.join(DATA_DIR, "mart_*_h*.duckdb")))
    if not periods:
        raise SystemExit("no mart_<YYYY>_h<N>.duckdb to publish")
    files = {**FILES, **{p: f"mart_{p}.duckdb" for p in periods}}

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    for prefix, local in files.items():
        path = os.path.join(DATA_DIR, local)
        name = f"{prefix}_{ts}.duckdb"
        with open(path, "rb") as f:
            lake_file(name).upload_data(f, overwrite=True, max_concurrency=8)
        print(f"uploaded {name} ({os.path.getsize(path) / 1e6:.0f} MB)", flush=True)

    # Last, once every file it leads to is there.
    lake_file("latest.json").upload_data(json.dumps({"ts": ts, "periods": periods}).encode(),
                                         overwrite=True)
    print(f"latest.json -> {ts}, {len(periods)} periods")

    # Keep the files of this run + the previous one; delete older ones. Every name ends in
    # its run's timestamp. latest.txt was the pointer before latest.json.
    names = [p.name.rsplit("/", 1)[-1] for p in lake.get_paths(FOLDER, recursive=False)]
    stamp = {n: m.group(1) for n in names if (m := re.search(r"_(\d{8}_\d{4})\.duckdb$", n))}
    keep = sorted(set(stamp.values()))[-2:]
    for name in [n for n, s in stamp.items() if s not in keep] + [n for n in names if n == "latest.txt"]:
        lake_file(name).delete_file()
        print(f"removed {name}")


if __name__ == "__main__":
    publish()
