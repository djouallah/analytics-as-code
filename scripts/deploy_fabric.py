"""Install the whole project into one Fabric workspace: the lakehouse, the hourly dbt run, the
semantic model and the report.

    WS_ID=<workspace id> python scripts/deploy_fabric.py [data] [model] [report] [ossie] [schedule|noschedule]

The arguments are the parts to deploy (all four when none is named), deploy_fabric.yml's ticks:
  data        steps 1-3: the lakehouse, the notebook, the pipeline and its run
  model       step 4: the semantic model, on the lakehouse already there
  report      step 4: the Power BI report, on the model already there
  ossie       step 5: ossie.yaml copied to the lakehouse already there
  schedule    step 6: the pipeline runs hourly
  noschedule  step 6: the pipeline's schedules are turned off (a test workspace's pipeline
              spends that capacity's CU every hour; nothing to do where there is none)

deploy_fabric.yml runs it, then deploys the front end (the VertiPaq Fabric app) into the same
workspace. The mechanism is the sibling repo's (fabric-medallion-dbt, .github/scripts/deploy.py):

  1. THE ITEMS in fabric_items/ are published with fabric-cicd: the lakehouse `nem`
     (schema-enabled), the notebook `run` and the pipeline `run_pipeline` that calls it.
     fabric-cicd rewrites the logical ids and the zero workspace id they name each other by.
  2. THE PROJECT goes to nem/Files/project as a folder, file by file: what the `run` notebook
     copies and runs. HEAD and not the working tree, so a laptop and CI upload the same files.
     The folder is deleted first: a model removed from the repo must not survive there.
  3. THE PIPELINE RUNS ONCE, and the deploy waits for it: the model names tables that a
     first run creates, and the run is what proves the notebook works.
  4. THE MODEL AND THE REPORT are published by deploy_model.py, the same publish as the
     `power` workspace's, with this workspace's lakehouse.
  5. OSSIE: HEAD's semantic_model/ossie.yaml is copied to nem/Files/semantic_model/ossie.yaml,
     its {WS_ID}/{LH_ID} replaced by this workspace's and lakehouse's ids. A copy, no Power BI.
  6. THE SCHEDULE, when asked: hourly, process_data.yml's cadence, or off.

Nothing here touches what runs from GitHub: the catalog of process_data.yml is the lakehouse
of WS_ID/LH_ID in the repository variables, and this installs a second, independent one.

Needs `az login` (azure/login on CI) as an identity that can create items in the workspace.
"""

import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ITEMS = REPO / "fabric_items"
LAKEHOUSE, PIPELINE = "nem", "run_pipeline"
PROJECT = "Files/project"
# What the `run` notebook needs of the repo: the dbt project and the pins it installs.
UPLOADED = ["dbt_project.yml", "profiles.yml", "models", "macros", "tests", "requirements.txt"]
MODEL = "semantic_model/ossie.yaml"

WS = os.environ["WS_ID"]


def credential():
    from azure.identity import AzureCliCredential
    return AzureCliCredential()


def fabric(method, path, body=None):
    """One call to the Fabric REST API for this workspace: (status, headers, json)."""
    token = credential().get_token("https://api.fabric.microsoft.com/.default").token
    request = urllib.request.Request(
        f"https://api.fabric.microsoft.com/v1/workspaces/{WS}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request) as r:
            raw = r.read()
            return r.status, r.headers, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path}: HTTP {e.code} {e.read().decode()[:500]}")


def item(kind, name):
    found = [i["id"] for i in fabric("GET", f"/{kind}")[2]["value"] if i["displayName"] == name]
    if not found:
        raise SystemExit(f"{name} is not in the workspace after the publish")
    return found[0]


def publish():
    from fabric_cicd import FabricWorkspace, publish_all_items
    publish_all_items(FabricWorkspace(
        workspace_id=WS,
        repository_directory=str(ITEMS),
        item_type_in_scope=["Lakehouse", "Notebook", "DataPipeline"],
        token_credential=credential(),
    ))


def onelake():
    """The workspace's OneLake, as a file system."""
    from azure.storage.filedatalake import DataLakeServiceClient
    return DataLakeServiceClient("https://onelake.dfs.fabric.microsoft.com",
                                 credential=credential()).get_file_system_client(WS)


def upload(lakehouse):
    commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO, check=True,
                            capture_output=True, text=True).stdout.strip()
    archive = zipfile.ZipFile(io.BytesIO(subprocess.run(
        ["git", "archive", "--format=zip", "HEAD", "--", *UPLOADED], cwd=REPO, check=True,
        capture_output=True).stdout))
    workspace = onelake()
    folder = workspace.get_directory_client(f"{lakehouse}/{PROJECT}")
    if folder.exists():
        folder.delete_directory()
    files = {n: archive.read(n) for n in archive.namelist() if not n.endswith("/")}
    files["COMMIT"] = f"{commit}\n".encode()
    for name, data in files.items():
        workspace.get_file_client(f"{lakehouse}/{PROJECT}/{name}").upload_data(data, overwrite=True)
    print(f"uploaded {len(files)} files of {commit} to {LAKEHOUSE}/{PROJECT}")


def upload_model(lakehouse):
    """HEAD's ossie.yaml, with this workspace and lakehouse in its OneLake address, as
    deploy_model.py fills them in."""
    data = subprocess.run(["git", "show", f"HEAD:{MODEL}"], cwd=REPO, check=True,
                          capture_output=True).stdout
    data = data.replace(b"{WS_ID}", WS.encode()).replace(b"{LH_ID}", lakehouse.encode())
    address = f"onelake.dfs.fabric.microsoft.com/{WS}/{lakehouse}".encode()
    if address not in data:
        raise SystemExit(f"{MODEL}: no {address.decode()} after filling in the ids")
    onelake().get_file_client(f"{lakehouse}/Files/{MODEL}").upload_data(data, overwrite=True)
    print(f"uploaded {MODEL} to {LAKEHOUSE}/Files/{MODEL}, naming {address.decode()}")


def run_and_wait(pipeline, lakehouse):
    _, headers, _ = fabric("POST", f"/items/{pipeline}/jobs/instances?jobType=Pipeline")
    job = headers["Location"].split(f"/workspaces/{WS}", 1)[1]
    print(f"{PIPELINE} started: {job}")
    started, status = time.monotonic(), None
    while True:
        time.sleep(30)
        body = fabric("GET", job)[2]
        if body.get("status") != status:
            status = body.get("status")
            print(f"{PIPELINE}: {status} after {int(time.monotonic() - started)} s", flush=True)
        if status in ("Completed", "Failed", "Cancelled", "Deduped"):
            break
    if status != "Completed":
        # The notebook's output stays in Fabric; it writes its log to Files/logs/run.log too.
        try:
            log = onelake().get_file_client(f"{lakehouse}/Files/logs/run.log").download_file().readall()
            print(f"--- the end of {LAKEHOUSE}/Files/logs/run.log ---")
            print("\n".join(log.decode(errors="replace").splitlines()[-80:]))
        except Exception as e:  # the log is an aid: its absence must not hide the failure
            print(f"no run log ({type(e).__name__}: {e})")
        raise SystemExit(f"{PIPELINE} {status}: {json.dumps(body.get('failureReason'))}")


def schedule(pipeline, on):
    """The pipeline hourly (`on`), or every schedule of it turned off."""
    path = f"/items/{pipeline}/jobs/Pipeline/schedules"
    schedules = fabric("GET", path)[2].get("value") or []
    if not on:
        for s in schedules:
            if s.get("enabled"):
                fabric("PATCH", f"{path}/{s['id']}", {"enabled": False, "configuration": s["configuration"]})
        print(f"{PIPELINE}: {len([s for s in schedules if s.get('enabled')])} schedule(s) turned off")
        return
    if any(s.get("enabled") for s in schedules):
        print(f"{PIPELINE} already runs on a schedule")
        return
    if schedules:
        s = schedules[0]
        fabric("PATCH", f"{path}/{s['id']}", {"enabled": True, "configuration": s["configuration"]})
        print(f"{PIPELINE}: its schedule turned back on")
        return
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    fabric("POST", path, {"enabled": True, "configuration": {
        "type": "Cron", "interval": 60, "localTimeZoneId": "UTC",
        "startDateTime": now.strftime("%Y-%m-%dT%H:%M:%S"),
        "endDateTime": (now + timedelta(days=5 * 365)).strftime("%Y-%m-%dT%H:%M:%S")}})
    print(f"{PIPELINE} scheduled hourly")


def main():
    args = set(sys.argv[1:])
    if args - {"data", "model", "report", "ossie", "schedule", "noschedule"} or {"schedule", "noschedule"} <= args:
        raise SystemExit("usage: deploy_fabric.py [data] [model] [report] [ossie] [schedule|noschedule], "
                         f"not {' '.join(sys.argv[1:])}")
    scheduling = args & {"schedule", "noschedule"}
    parts = (args - scheduling) or (set() if scheduling else {"data", "model", "report", "ossie"})
    pipeline = None
    if "data" in parts:
        publish()
        pipeline = item("items?type=DataPipeline", PIPELINE)
        lakehouse = item("lakehouses", LAKEHOUSE)
        upload(lakehouse)
        run_and_wait(pipeline, lakehouse)
    published = [t for p, t in (("model", "SemanticModel"), ("report", "Report")) if p in parts]
    if published:
        os.environ["LH_ID"] = item("lakehouses", LAKEHOUSE)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import deploy_model
        deploy_model.main(published)
        print(f"published {', '.join(published)}")
    if "ossie" in parts:
        upload_model(item("lakehouses", LAKEHOUSE))
    if "noschedule" in scheduling and not pipeline and not [
            i for i in fabric("GET", "/items?type=DataPipeline")[2]["value"] if i["displayName"] == PIPELINE]:
        print(f"no {PIPELINE} in the workspace: no schedule to turn off")
    elif scheduling:
        schedule(pipeline or item("items?type=DataPipeline", PIPELINE), "schedule" in scheduling)


if __name__ == "__main__":
    main()
