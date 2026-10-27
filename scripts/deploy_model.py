"""Publish the semantic model to the Fabric workspace that holds the catalog's lakehouse.

    python deploy_model.py

The model is semantic_model/ossie.yaml, in Apache Ossie, the file the dashboards read; the repo
holds nothing else of it. The Fabric item is written here, into a temporary semantic_model/:
model.bim, the TMSL the YAML stands for (scripts/ossie_to_bim.mjs: a Tabular model whose
tables are Direct Lake partitions on the Iceberg tables of the `nem` lakehouse; what Ossie has
no place for is in the YAML's POWER_BI extensions), definition.pbism, and .platform, named
after the model (its `name`) with a fixed logicalId. fabric-cicd finds an item by its
.platform. It is published with fabric-cicd, as the sibling repo publishes its own
(dbt-fabric, .github/scripts/deploy.py): the item is created on the first run and updated
after that.

The model names the lakehouse as {WS_ID}/{LH_ID}: Direct Lake has no parameter for them, they
are literals in the DirectLake expression, and the repo does not hold the ids (they are
repository variables). They are written in here, on a copy.

Needs `az login` (azure/login on CI) as an identity that can create items in the workspace,
and node with `npm ci --prefix scripts` (yaml) for ossie_to_bim.mjs.
"""

import json
import os
import subprocess
import tempfile
from pathlib import Path

import yaml  # fabric-cicd brings it

REPO = Path(__file__).resolve().parent.parent
ITEM = REPO / "semantic_model"
# The model's name in the workspace: the Ossie model's.
NAME = yaml.safe_load((ITEM / "ossie.yaml").read_text(encoding="utf-8"))["name"]
# The item's identity in fabric-cicd's eyes; the same on every deploy.
LOGICAL_ID = "d0f250b0-e001-44ac-91d8-48faea5ec2ed"
PLATFORM = {
    "$schema": "https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json",
    "metadata": {"type": "SemanticModel", "displayName": NAME},
    "config": {"version": "2.0", "logicalId": LOGICAL_ID},
}


def main():
    from azure.identity import AzureCliCredential
    from fabric_cicd import FabricWorkspace, publish_all_items

    workspace, lakehouse = os.environ["WS_ID"], os.environ["LH_ID"]
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp).resolve()
        item = tmp / ITEM.relative_to(REPO)
        item.mkdir(parents=True)
        (item / ".platform").write_text(json.dumps(PLATFORM, indent=2), encoding="utf-8")
        (item / "definition.pbism").write_text(json.dumps({"version": "1.0"}), encoding="utf-8")
        bim = item / "model.bim"
        subprocess.run(["node", str(REPO / "scripts" / "ossie_to_bim.mjs"), str(bim)], check=True)
        bim.write_text(bim.read_text(encoding="utf-8")
                       .replace("{WS_ID}", workspace).replace("{LH_ID}", lakehouse), encoding="utf-8")
        publish_all_items(FabricWorkspace(
            workspace_id=workspace,
            repository_directory=str(tmp),
            item_type_in_scope=["SemanticModel"],
            token_credential=AzureCliCredential(),
        ))


if __name__ == "__main__":
    main()
