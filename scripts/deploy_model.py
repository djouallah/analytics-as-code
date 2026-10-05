"""Publish the semantic model to the Fabric workspace that holds the catalog's lakehouse.

    python deploy_model.py

The model is semantic_model/model.bim (a Tabular model in TMSL whose tables are Direct Lake
partitions on the Iceberg tables of the `nem` lakehouse), the same file the dashboards
read. With .platform and definition.pbism next to it, that folder is a Fabric item:
fabric-cicd finds an item by its .platform, whatever the folder is called. It is
published with fabric-cicd, as the sibling repo publishes its own (dbt-fabric,
.github/scripts/deploy.py): the item is created on the first run and updated after that.

model.bim names the lakehouse as {WS_ID}/{LH_ID}: Direct Lake has no parameter for them, they
are literals in the DirectLake expression, and the repo does not hold the ids (they are
repository variables). They are written in here, on a copy.

Needs `az login` (azure/login on CI) as an identity that can create items in the workspace.
"""

import os
import shutil
import tempfile
from pathlib import Path

ITEM = Path(__file__).resolve().parent.parent / "semantic_model"


def main():
    from azure.identity import AzureCliCredential
    from fabric_cicd import FabricWorkspace, publish_all_items

    workspace, lakehouse = os.environ["WS_ID"], os.environ["LH_ID"]
    with tempfile.TemporaryDirectory() as tmp:
        bim = Path(shutil.copytree(ITEM, Path(tmp, ITEM.name)), "model.bim")
        bim.write_text(bim.read_text(encoding="utf-8")
                       .replace("{WS_ID}", workspace).replace("{LH_ID}", lakehouse), encoding="utf-8")
        publish_all_items(FabricWorkspace(
            workspace_id=workspace,
            repository_directory=tmp,
            item_type_in_scope=["SemanticModel"],
            token_credential=AzureCliCredential(),
        ))


if __name__ == "__main__":
    main()
