"""Install the whole project into one Fabric workspace: the lakehouse, the hourly dbt run and the
daily dbt test, the semantic model.

    WS_ID=<workspace id> python scripts/deploy_fabric.py [data] [maintain] [test] [model] [ossie] [schedule|noschedule]

The arguments are the parts to deploy (data, model and ossie when none is named), deploy_fabric.yml's ticks:
  data        steps 1-3: the lakehouse, the notebook, the pipelines and a run of run_pipeline
  maintain    step 3: the run of run_pipeline (one even without data) does the table
              maintenance after its load, as its 21:00 UTC run does every day
  test        step 3b: a run of test_pipeline (dbt test), waited for
  model       step 4: the semantic model, on the lakehouse already there
  ossie       step 5: ossie.yaml copied to the lakehouse already there
  schedule    step 6: run_pipeline hourly, test_pipeline daily
  noschedule  step 6: the pipelines' schedules are turned off (a test workspace's pipeline
              spends that capacity's CU every hour; nothing to do where there is none)

DOWNLOAD_LIMIT and PROCESS_LIMIT (env, optional) are the files per feed per run that
run_pipeline passes the notebook: process_data.yml's 200 and 300 on power, the 10 of
fabric_items/ elsewhere.

deploy_fabric.yml runs it, then deploys the front end (the Fabric apps) into the same
workspace. The mechanism is the sibling repo's (fabric-medallion-dbt, .github/scripts/deploy.py):

  1. THE ITEMS in fabric_items/ are published with fabric-cicd: the lakehouse `nem`
     (schema-enabled), the notebook `run` and the pipelines that call it, `run_pipeline`
     (command=run, the load; at 21:00 UTC, or with maintain=true, then command=maintain, the
     table maintenance) and `test_pipeline` (command=test). The timeouts are the
     pipelines' activity policies. fabric-cicd rewrites the logical ids and the zero workspace
     id they name each other by.
  2. THE PROJECT goes to nem/Files/project as a folder, file by file: what the `run` notebook
     copies and runs (the dbt project, and scripts/maintain/maintain, the committed binary of
     the maintenance tool). HEAD and not the working tree, so a laptop and CI upload the same files.
     The folder is deleted first: a model removed from the repo must not survive there.
  3. RUN_PIPELINE RUNS ONCE, and the deploy waits for it: the model names tables that a
     first run creates, and the run is what proves the notebook works.
  4. THE MODEL is published by deploy_model.py, the same publish as the
     `power` workspace's, with this workspace's lakehouse.
  5. OSSIE: HEAD's semantic_model/ossie.yaml is copied to nem/Files/semantic_model/ossie.yaml,
     its {WS_ID}/{LH_ID} replaced by this workspace's and lakehouse's ids. A copy, no Power BI.
  6. THE SCHEDULES, when asked: run_pipeline hourly on the hour (process_data.yml's cadence),
     test_pipeline daily at 21:15 UTC, or both off.

On power (WS_ID/LH_ID of the repository variables) this is the production pipeline, which
process_data.yml ran from GitHub before; on any other workspace an independent copy.

Needs `az login` (azure/login on CI) as an identity that can create items in the workspace.
"""

import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ITEMS = REPO / "fabric_items"
LAKEHOUSE, PIPELINE, TEST_PIPELINE = "nem", "run_pipeline", "test_pipeline"
PROJECT = "Files/project"
# What the `run` notebook needs of the repo: the dbt project (dbt/), the pins it installs, and
# the table maintenance tool, a binary committed to the repo (scripts/maintain/go.mod says how).
UPLOADED = ["dbt", "requirements.txt", "scripts/maintain/maintain"]
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
    """fabric_items/, with run_pipeline's limits set from DOWNLOAD_LIMIT/PROCESS_LIMIT."""
    from fabric_cicd import FabricWorkspace, publish_all_items
    with tempfile.TemporaryDirectory() as tmp:
        items = Path(tmp) / "fabric_items"
        shutil.copytree(ITEMS, items)
        content = items / f"{PIPELINE}.DataPipeline" / "pipeline-content.json"
        pipeline = json.loads(content.read_text(encoding="utf-8"))
        parameters = pipeline["properties"]["activities"][0]["typeProperties"]["parameters"]
        for name in ("download_limit", "process_limit"):
            value = os.environ.get(name.upper())
            if value:
                parameters[name]["value"] = value
            print(f"{PIPELINE}: {name}={parameters[name]['value']}")
        content.write_text(json.dumps(pipeline, indent=2), encoding="utf-8")
        publish_all_items(FabricWorkspace(
            workspace_id=WS,
            repository_directory=str(items),
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


def run_and_wait(name, pipeline, lakehouse, log, parameters=None):
    """One run of a pipeline, waited for; on failure the end of the notebook's log
    (Files/logs/<log>.log) is printed, as the notebook's output stays in Fabric."""
    body = {"executionData": {"parameters": parameters}} if parameters else None
    _, headers, _ = fabric("POST", f"/items/{pipeline}/jobs/instances?jobType=Pipeline", body)
    job = headers["Location"].split(f"/workspaces/{WS}", 1)[1]
    print(f"{name} started: {job}")
    started, status = time.monotonic(), None
    while True:
        time.sleep(30)
        body = fabric("GET", job)[2]
        if body.get("status") != status:
            status = body.get("status")
            print(f"{name}: {status} after {int(time.monotonic() - started)} s", flush=True)
        if status in ("Completed", "Failed", "Cancelled", "Deduped"):
            break
    if status != "Completed":
        try:
            text = onelake().get_file_client(f"{lakehouse}/Files/logs/{log}.log").download_file().readall()
            print(f"--- the end of {LAKEHOUSE}/Files/logs/{log}.log ---")
            print("\n".join(text.decode(errors="replace").splitlines()[-80:]))
        except Exception as e:  # the log is an aid: its absence must not hide the failure
            print(f"no run log ({type(e).__name__}: {e})")
        raise SystemExit(f"{name} {status}: {json.dumps(body.get('failureReason'))}")



def schedule(name, pipeline, configuration):
    """The pipeline on `configuration` (its first schedule rewritten, or a new one), or, with
    None, every schedule of it turned off."""
    path = f"/items/{pipeline}/jobs/Pipeline/schedules"
    schedules = fabric("GET", path)[2].get("value") or []
    if configuration is None:
        on = [s for s in schedules if s.get("enabled")]
        for s in on:
            fabric("PATCH", f"{path}/{s['id']}", {"enabled": False, "configuration": s["configuration"]})
        print(f"{name}: {len(on)} schedule(s) turned off")
        return
    if schedules:
        fabric("PATCH", f"{path}/{schedules[0]['id']}", {"enabled": True, "configuration": configuration})
        for s in schedules[1:]:
            if s.get("enabled"):
                fabric("PATCH", f"{path}/{s['id']}", {"enabled": False, "configuration": s["configuration"]})
    else:
        fabric("POST", path, {"enabled": True, "configuration": configuration})
    print(f"{name} scheduled: {json.dumps(configuration)}")


def schedules(on):
    """run_pipeline hourly from the next whole hour, test_pipeline daily at 21:15 UTC; or off."""
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    window = {"localTimeZoneId": "UTC", "startDateTime": start.strftime("%Y-%m-%dT%H:%M:%S"),
              "endDateTime": (start + timedelta(days=5 * 365)).strftime("%Y-%m-%dT%H:%M:%S")}
    wanted = {PIPELINE: {"type": "Cron", "interval": 60, **window},
              TEST_PIPELINE: {"type": "Daily", "times": ["21:15"], **window}}
    present = {i["displayName"]: i["id"] for i in fabric("GET", "/items?type=DataPipeline")[2]["value"]}
    for name, configuration in wanted.items():
        if name not in present:
            if on:
                raise SystemExit(f"{name} is not in the workspace: deploy it with data")
            print(f"no {name} in the workspace: no schedule to turn off")
            continue
        schedule(name, present[name], configuration if on else None)


def main():
    args = set(sys.argv[1:])
    if args - {"data", "maintain", "test", "model", "ossie", "schedule", "noschedule"} or {"schedule", "noschedule"} <= args:
        raise SystemExit("usage: deploy_fabric.py [data] [maintain] [test] [model] [ossie] [schedule|noschedule], "
                         f"not {' '.join(sys.argv[1:])}")
    scheduling = args & {"schedule", "noschedule"}
    parts = (args - scheduling) or (set() if scheduling else {"data", "model", "ossie"})
    if "data" in parts:
        publish()
        lakehouse = item("lakehouses", LAKEHOUSE)
        upload(lakehouse)
    if parts & {"data", "maintain"}:
        maintain = "maintain" in parts
        lakehouse = item("lakehouses", LAKEHOUSE)
        run_and_wait(PIPELINE, item("items?type=DataPipeline", PIPELINE), lakehouse, "run",
                     {"maintain": True} if maintain else None)
        if maintain:  # maintenance never fails the run: its log says what it did
            text = onelake().get_file_client(f"{lakehouse}/Files/logs/maintain.log").download_file().readall()
            print(f"--- {LAKEHOUSE}/Files/logs/maintain.log ---")
            print(text.decode(errors="replace"))
    if "test" in parts:
        run_and_wait(TEST_PIPELINE, item("items?type=DataPipeline", TEST_PIPELINE),
                     item("lakehouses", LAKEHOUSE), "test")
    if "model" in parts:
        os.environ["LH_ID"] = item("lakehouses", LAKEHOUSE)
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import deploy_model
        deploy_model.main()
        print("published the semantic model")
    if "ossie" in parts:
        upload_model(item("lakehouses", LAKEHOUSE))
    if scheduling:
        schedules("schedule" in scheduling)


if __name__ == "__main__":
    main()
