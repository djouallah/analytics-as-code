"""Publish the semantic model, and the Power BI report on it, to the Fabric workspace that
holds the catalog's lakehouse.

    python deploy_model.py

The model is semantic_model/model.bim (a Tabular model in TMSL whose tables are Direct Lake
partitions on the Iceberg tables of the `nem` lakehouse), the same file the dashboards
read. With .platform and definition.pbism next to it, that folder is a Fabric item:
fabric-cicd finds an item by its .platform, whatever the folder is called. It is
published with fabric-cicd, as the sibling repo publishes its own (dbt-fabric,
.github/scripts/deploy.py): the item is created on the first run and updated after that.

The report is dashboard/powerbi_report/nem.Report (PBIR). Its definition.pbir names the model by
its path in the repo, and fabric-cicd turns that into the deployed model's id, so the two
are copied to the same places relative to each other and nothing in the report is rewritten.

model.bim names the lakehouse as {WS_ID}/{LH_ID}: Direct Lake has no parameter for them, they
are literals in the DirectLake expression, and the repo does not hold the ids (they are
repository variables). They are written in here, on a copy.

Needs `az login` (azure/login on CI) as an identity that can create items in the workspace.
"""

import os
import shutil
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
ITEM = REPO / "semantic_model"
REPORT = REPO / "dashboard" / "powerbi_report" / "nem.Report"


def main(items=("SemanticModel", "Report")):
    """items: what to publish, both by default (deploy_fabric.py can ask for one)."""
    from azure.identity import AzureCliCredential
    from fabric_cicd import FabricWorkspace, publish_all_items

    workspace, lakehouse = os.environ["WS_ID"], os.environ["LH_ID"]
    with tempfile.TemporaryDirectory() as tmp:
        # Resolved: fabric-cicd finds the report's model by comparing resolved paths.
        tmp = Path(tmp).resolve()
        bim = Path(shutil.copytree(ITEM, tmp / ITEM.relative_to(REPO)), "model.bim")
        bim.write_text(bim.read_text(encoding="utf-8")
                       .replace("{WS_ID}", workspace).replace("{LH_ID}", lakehouse), encoding="utf-8")
        shutil.copytree(REPORT, tmp / REPORT.relative_to(REPO))
        publish_all_items(FabricWorkspace(
            workspace_id=workspace,
            repository_directory=str(tmp),
            item_type_in_scope=list(items),
            token_credential=AzureCliCredential(),
        ))


if __name__ == "__main__":
    main()
