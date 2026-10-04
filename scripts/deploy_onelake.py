"""Publish the dashboard's .duckdb files to the Fabric app's lakehouse (OneLake).

    python deploy_onelake.py

The counterpart of deploy_pages.sh for the Fabric app (djouallah/fabric-energy-app), which
reads the same files from OneLake instead of GitHub Pages. Run after cache_catalog.py's
build_* steps with MAX_FILE_MB=unlimited, so the 5-minute history is one file: the app reads
it in place over HTTP.

    energy_dim.duckdb        ->  dim_<ts>.duckdb
    energy_today.duckdb      ->  today_<ts>.duckdb
    energy_daily_agg.duckdb  ->  agg_<ts>.duckdb
    energy_data.duckdb       ->  data_<ts>.duckdb
    latest.txt                   the current data_<ts>.duckdb; the other names follow from its <ts>

The files are immutable and named by timestamp, and two versions of each are kept: a page
opened before this run still reads the previous one.
"""

import json
import os
import urllib.request
from datetime import datetime, timezone

from azure.identity import ClientAssertionCredential
from azure.storage.filedatalake import DataLakeServiceClient

DASHBOARD_DIR = os.path.join(os.path.dirname(__file__), "..", "dashboard")
# Where the app reads: workspace `app`, lakehouse `data`, in another tenant than the catalog's.
LAKE = "https://onelake.dfs.fabric.microsoft.com"
WORKSPACE, FOLDER = "app", "data.Lakehouse/Files/data"
FILES = {
    "dim": "energy_dim.duckdb",
    "today": "energy_today.duckdb",
    "agg": "energy_daily_agg.duckdb",
    "data": "energy_data.duckdb",
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

    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    for prefix, local in FILES.items():
        path = os.path.join(DASHBOARD_DIR, local)
        name = f"{prefix}_{ts}.duckdb"
        with open(path, "rb") as f:
            lake_file(name).upload_data(f, overwrite=True, max_concurrency=8)
        print(f"uploaded {name} ({os.path.getsize(path) / 1e6:.0f} MB)", flush=True)

    # Last, once every file it leads to is there.
    lake_file("latest.txt").upload_data(f"data_{ts}.duckdb".encode(), overwrite=True)
    print(f"latest.txt -> data_{ts}.duckdb")

    # Keep the new files + 1 previous version; delete older ones. Names carry the timestamp,
    # so sorted order is chronological.
    names = sorted(p.name.rsplit("/", 1)[-1] for p in lake.get_paths(FOLDER, recursive=False))
    for prefix in FILES:
        for name in [n for n in names if n.startswith(f"{prefix}_") and n.endswith(".duckdb")][:-2]:
            lake_file(name).delete_file()
            print(f"removed {name}")


if __name__ == "__main__":
    publish()
