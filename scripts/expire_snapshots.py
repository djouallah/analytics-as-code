"""Expire old Iceberg snapshots (daily maintenance, immediately after compaction).

process_data commits every 30 minutes and duckdb-iceberg has no snapshot expiry, so nothing
on the write path ever drops a snapshot. Compaction makes that worse before it makes it
better — iceberg_rewrite_data_files() adds one more snapshot and leaves every previous one
pointing at the small files it just replaced. So this runs *after* compact_iceberg.py, on
pyiceberg, which does have expire_snapshots().

Measured on the first run (2026-08-25): every table held 16-18 snapshots and none was older
than a day, so this expired nothing. Something on the OneLake side is already trimming the
snapshot list — this is a bounded safety net, not a backlog cleaner. If a table is ever seen
carrying more than ~48 snapshots (a day's commits), that assumption has changed.

What this buys, precisely: pyiceberg's ExpireSnapshots stages a RemoveSnapshotsUpdate and
nothing else. Snapshot entries leave the table metadata — the metadata JSON stops growing
without bound and planning stays cheap — but no files are deleted. The orphaned data files
stay in OneLake unless the service itself collects them. This is not a way to reclaim
storage; don't let the report be read as one.

The catalog gets the last word on whether a `remove-snapshots` update is accepted at all, so
every table is best-effort, the metadata is re-read afterwards rather than trusting the
commit, and nothing here ever fails the pipeline.

Usage:
    python scripts/expire_snapshots.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.utils.datetime import datetime_to_millis

from iceberg_tables import TABLES

ENDPOINT = os.environ["ONELAKE_ENDPOINT"]
TOKEN = os.environ["ONELAKE_TOKEN"]
WAREHOUSE = os.environ["WAREHOUSE_PATH"]      # "{workspace_id}/{lakehouse_id}"

# Nothing in this repo time-travels: the dashboard export and every dbt model read the
# current snapshot. A day of history is a rollback window, not a feature.
DAYS = float(os.environ.get("EXPIRE_OLDER_THAN_DAYS", "1"))

# The REST update this script issues, as advertised in GET /v1/config's `endpoints` list.
UPDATE_TABLE_ENDPOINT = "POST /v1/{prefix}/namespaces/{namespace}/tables/{table}"


def oneline(e):
    """Collapse an error to its first line, trimmed — REST errors carry a JSON body."""
    return " ".join(str(e).split("\n")[0].split())[:160]


def connect():
    """A REST catalog on the same endpoint/token duckdb uses.

    No adls credential object: expiring snapshots is a metadata-only round trip through the
    REST catalog, so pyiceberg's FileIO is never exercised. If that ever changes it fails
    loudly here rather than silently doing half the job, and the fix is to hand it a
    static-token credential.
    """
    return RestCatalog(
        "onelake",
        **{
            "uri": ENDPOINT,
            "token": TOKEN,
            "warehouse": WAREHOUSE,
            "adls.account-name": "onelake",
            "adls.account-host": "onelake.blob.fabric.microsoft.com",
        },
    )


def update_table_capability():
    """The installed pyiceberg's handle for the update-table endpoint, or None.

    It has been spelled two ways across releases (Capability.V1_UPDATE_TABLE, and before
    that an Endpoint parsed from the wire string), so look for both rather than pinning
    this script to one internal name.
    """
    from pyiceberg.catalog import rest as rest_module

    capability = getattr(rest_module, "Capability", None)
    if capability is not None and hasattr(capability, "V1_UPDATE_TABLE"):
        return capability.V1_UPDATE_TABLE

    endpoint = getattr(rest_module, "Endpoint", None)
    if endpoint is not None and hasattr(endpoint, "from_string"):
        return endpoint.from_string(UPDATE_TABLE_ENDPOINT)

    return None


def allow_table_updates(catalog):
    """Let the server, not the client, decide whether it accepts a metadata commit.

    pyiceberg's RestCatalog gates commit_table on the `endpoints` list from GET /v1/config
    and raises NotImplementedError before making the call if the update-table endpoint
    isn't advertised. Microsoft's docs describe the OneLake IRC endpoint as read-only and
    show a config response carrying GET/HEAD only, which would veto this script client-side
    — but the live catalog advertises 13 endpoints including update-table (checked
    2026-08-25), matching the fact that duckdb commits to it every 30 minutes. So the
    override below is a fallback that normally doesn't fire; the printed endpoint list is
    the evidence for which case we're in. If OneLake ever does refuse the update, we want
    its 4xx in the report rather than a client-side guess.
    """
    supported = getattr(catalog, "_supported_endpoints", None)
    if supported is None:
        print("(pyiceberg exposes no endpoint gate — nothing to unlock)", flush=True)
        return

    print(f"catalog advertises {len(supported)} endpoint(s): "
          f"{', '.join(sorted(str(e) for e in supported))}", flush=True)

    capability = update_table_capability()
    if capability is None:
        print("::warning::could not resolve pyiceberg's update-table endpoint handle; "
              "a commit may be refused client-side", flush=True)
        return

    if capability in supported:
        print("update-table is advertised — no override needed", flush=True)
        return

    supported.add(capability)
    print("update-table is NOT advertised — overriding the client-side gate so the "
          "catalog can answer for itself", flush=True)


def expire(catalog, table, cutoff, cutoff_ms):
    """Expire one table's old snapshots. Returns (table, status) for the report."""
    try:
        tbl = catalog.load_table(table)
    except Exception as e:
        return (table, f"ERROR loading: {type(e).__name__}: {oneline(e)}")

    snapshots = tbl.metadata.snapshots or []
    # Branch heads and tags are protected by pyiceberg anyway; count the same way
    # ExpireSnapshots.older_than() does — same refs, same millisecond conversion — so the
    # "nothing to do" report can't disagree with what a commit would have removed.
    protected = {ref.snapshot_id for ref in tbl.metadata.refs.values()}
    victims = [s.snapshot_id for s in snapshots
               if s.timestamp_ms < cutoff_ms and s.snapshot_id not in protected]

    before = len(snapshots)
    if not victims:
        return (table, f"nothing older than {DAYS:g}d ({before} snapshots)")

    try:
        tbl.maintenance.expire_snapshots().older_than(cutoff).commit()
    except Exception as e:
        return (table, f"ERROR: {type(e).__name__}: {oneline(e)}")

    # Re-read from the catalog. A commit that returns without raising is not evidence that
    # it landed — this catalog has form for accepting writes it doesn't apply.
    try:
        after = len(catalog.load_table(table).metadata.snapshots or [])
    except Exception as e:
        return (table, f"committed {len(victims)}, but re-read failed: {oneline(e)}")

    if after >= before:
        return (table, f"NO-OP (asked for {len(victims)}, still {after} snapshots)")
    return (table, f"OK ({before} -> {after} snapshots, {len(victims)} expired)")


def report(lines, pyiceberg_version):
    title = f"Iceberg snapshot expiry (pyiceberg {pyiceberg_version}, older than {DAYS:g}d)"
    out = ["=" * 100, title, "-" * 100]
    for table, status in lines:
        out.append(f"{table:<32}{status}")
    out.append("=" * 100)
    out.append("Metadata only — expired snapshots free no storage; their data files remain.")
    print("\n".join(out))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## {title}\n\n")
            f.write("| table | result |\n|---|---|\n")
            for table, status in lines:
                f.write(f"| `{table}` | {status} |\n")
            f.write("\nMetadata only — expired snapshots free no storage; their data "
                    "files remain in OneLake.\n\n")


def main():
    import pyiceberg

    version = getattr(pyiceberg, "__version__", "unknown")
    cutoff = datetime.now(timezone.utc) - timedelta(days=DAYS)
    cutoff_ms = datetime_to_millis(cutoff)
    print(f"pyiceberg {version} — expiring snapshots older than {cutoff.isoformat()} "
          f"across {len(TABLES)} table(s):")
    for t in TABLES:
        print(f"  - {t}")
    print(flush=True)

    catalog = connect()
    allow_table_updates(catalog)
    print(flush=True)

    total = len(TABLES)
    lines = []
    for i, table in enumerate(TABLES, 1):
        prefix = f"[{i}/{total}] {table}"
        print(f"{prefix} ... expiring", flush=True)
        _, status = expire(catalog, table, cutoff, cutoff_ms)
        print(f"{prefix}: {status}\n", flush=True)
        lines.append((table, status))

    report(lines, version)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"expire_snapshots failed (non-fatal): {e}", file=sys.stderr)
