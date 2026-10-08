"""Expire old Iceberg snapshots (daily maintenance, immediately after compaction).

process_data commits every hour and duckdb-iceberg has no snapshot expiry, so nothing
on the write path ever drops a snapshot. Compaction makes that worse before it makes it
better — iceberg_rewrite_data_files() adds one more snapshot and leaves every previous one
pointing at the small files it just replaced. So this runs *after* compact_iceberg.py, on
pyiceberg, which does have expire_snapshots().

Measured on the first run (2026-08-25): every table held 16-18 snapshots and none was older
than a day, so this expired nothing. Something on the OneLake side is already trimming the
snapshot list — this is a bounded safety net, not a backlog cleaner. If a table is ever seen
carrying more than ~48 snapshots (a day's commits), that assumption has changed.

What expiry buys, precisely: pyiceberg's ExpireSnapshots stages a RemoveSnapshotsUpdate and
nothing else. Snapshot entries leave the table metadata — the metadata JSON stops growing
without bound and planning stays cheap — but no files are deleted.

The files are the second half: after each table's expiry, remove_orphan_files() (pyiceberg
PR #3361, unreleased; installed from djouallah/iceberg-python at that PR's commit) lists the
table's folder and deletes what no snapshot or metadata file references, older than
ORPHAN_OLDER_THAN_DAYS. It skips every path with a component starting with `_` or `.`
(OneLake's `_delta_log` among them), and it refuses to delete when a listed path and a
referenced one differ only in scheme or host. ORPHAN_DRY_RUN (default true) lists without
deleting: deletion is irreversible, so it is switched on only after a dry run has been read.

The catalog gets the last word on whether a `remove-snapshots` update is accepted at all, so
every table is best-effort, the metadata is re-read afterwards rather than trusting the
commit, and nothing here ever fails the pipeline.

Usage:
    python scripts/expire_snapshots.py
"""

import os
import sys
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

from pyiceberg.catalog.rest import RestCatalog
from pyiceberg.utils.datetime import datetime_to_millis

from iceberg_tables import TABLES

ENDPOINT = os.environ["ONELAKE_ENDPOINT"]
TOKEN = os.environ["ONELAKE_TOKEN"]
WAREHOUSE = os.environ["WAREHOUSE_PATH"]      # "{workspace_id}/{lakehouse_id}"

# Nothing in this repo time-travels: the dashboard's copy and every dbt model read the
# current snapshot. A day of history is a rollback window, not a feature.
DAYS = float(os.environ.get("EXPIRE_OLDER_THAN_DAYS", "1"))

# A file younger than this may belong to a commit in flight, so it is never a candidate.
ORPHAN_DAYS = float(os.environ.get("ORPHAN_OLDER_THAN_DAYS", "3"))
ORPHAN_DRY_RUN = os.environ.get("ORPHAN_DRY_RUN", "true").strip().lower() != "false"
HIDDEN = ("_", ".")

# The REST update this script issues, as advertised in GET /v1/config's `endpoints` list.
UPDATE_TABLE_ENDPOINT = "POST /v1/{prefix}/namespaces/{namespace}/tables/{table}"


def oneline(e):
    """Collapse an error to its first line, trimmed — REST errors carry a JSON body."""
    return " ".join(str(e).split("\n")[0].split())[:160]


def connect():
    """A REST catalog on the same endpoint/token duckdb uses.

    Expiry is a metadata-only round trip, but the orphan pass lists and deletes files, so
    the FileIO gets the same storage token (adlfs, as a static bearer credential).
    """
    return RestCatalog(
        "onelake",
        **{
            "uri": ENDPOINT,
            "token": TOKEN,
            "warehouse": WAREHOUSE,
            "py-io-impl": "pyiceberg.io.fsspec.FsspecFileIO",
            "adls.token": TOKEN,
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
    2026-08-25), matching the fact that duckdb commits to it every hour. So the
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


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def remove_orphans(catalog, table):
    """List one table's folder and remove (or, in a dry run, only name) its orphan files.

    Returns the status line for the report. The detail — sample paths on both sides, so a
    scheme or host mismatch can be seen — goes to the log only.
    """
    import time

    try:
        tbl = catalog.load_table(table)
    except Exception as e:
        return f"ERROR loading: {type(e).__name__}: {oneline(e)}"

    if not hasattr(tbl.maintenance, "remove_orphan_files"):
        return "SKIPPED: this pyiceberg has no remove_orphan_files"

    # Keep what the listing returns on its way through, to report it without listing twice.
    location = tbl.metadata.location
    listed = []
    io = tbl.io
    list_prefix = io.list_prefix

    def keeping(loc):
        for entry in list_prefix(loc):
            listed.append(entry)
            yield entry

    io.list_prefix = keeping

    print(f"    location:   {location}")
    print(f"    referenced: {tbl.metadata_location}")
    snapshot = tbl.current_snapshot()
    if snapshot is not None and snapshot.manifest_list:
        print(f"    referenced: {snapshot.manifest_list}")

    start = time.monotonic()
    action = tbl.maintenance.remove_orphan_files().older_than(timedelta(days=ORPHAN_DAYS))
    if ORPHAN_DRY_RUN:
        action = action.dry_run()
    try:
        result = action.execute()
    except Exception as e:
        print(f"    listed {len(listed)} file(s), then {type(e).__name__}: {e}")
        for entry in listed[:3]:
            print(f"    listed:     {entry.location}")
        return f"ERROR: {type(e).__name__}: {oneline(e)}"
    seconds = time.monotonic() - start

    # By path, not by string: the listing may spell the host differently from the metadata.
    root = urlparse(location).path.rstrip("/")
    hidden = sum(1 for e in listed
                 if any(c.startswith(HIDDEN)
                        for c in urlparse(e.location).path[len(root):].split("/") if c))
    for entry in listed[:3]:
        print(f"    listed:     {entry.location}")
    for path in result.orphan_file_locations[:3]:
        print(f"    orphan:     {path}")

    what = (f"{len(result.orphan_file_locations)} orphan(s), {human(result.total_bytes)}, "
            f"of {len(listed)} listed ({hidden} hidden, skipped) in {seconds:.0f}s")
    if ORPHAN_DRY_RUN:
        return f"DRY RUN: {what}"
    failed = len(result.failed_to_delete)
    return (f"deleted {len(result.deleted_files)}" + (f", {failed} FAILED" if failed else "")
            + f": {what}")


def report(lines, pyiceberg_version):
    title = f"Iceberg snapshot expiry (pyiceberg {pyiceberg_version}, older than {DAYS:g}d)"
    mode = "dry run" if ORPHAN_DRY_RUN else "deleting"
    orphan_title = f"Orphan files (older than {ORPHAN_DAYS:g}d, {mode})"
    out = ["=" * 100, title, "-" * 100]
    for table, status, _ in lines:
        out.append(f"{table:<32}{status}")
    out += ["=" * 100, orphan_title, "-" * 100]
    for table, _, orphans in lines:
        out.append(f"{table:<32}{orphans}")
    out.append("=" * 100)
    print("\n".join(out))

    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write(f"## {title}\n\n")
            f.write(f"| table | expiry | {orphan_title} |\n|---|---|---|\n")
            for table, status, orphans in lines:
                f.write(f"| `{table}` | {status} | {orphans} |\n")
            f.write("\n")


def main():
    import pyiceberg

    version = getattr(pyiceberg, "__version__", "unknown")
    cutoff = datetime.now(timezone.utc) - timedelta(days=DAYS)
    cutoff_ms = datetime_to_millis(cutoff)
    print(f"pyiceberg {version} — expiring snapshots older than {cutoff.isoformat()}, then "
          f"orphan files older than {ORPHAN_DAYS:g}d "
          f"({'dry run' if ORPHAN_DRY_RUN else 'DELETING'}), across {len(TABLES)} table(s):")
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
        print(f"{prefix}: {status}", flush=True)
        print(f"{prefix} ... orphan files", flush=True)
        try:
            orphans = remove_orphans(catalog, table)
        except Exception as e:
            orphans = f"ERROR: {type(e).__name__}: {oneline(e)}"
        print(f"{prefix}: {orphans}\n", flush=True)
        lines.append((table, status, orphans))

    report(lines, version)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Maintenance must never fail the pipeline.
        print(f"expire_snapshots failed (non-fatal): {e}", file=sys.stderr)
