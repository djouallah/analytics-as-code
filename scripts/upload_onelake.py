"""Upload the dashboard's .duckdb files to a lakehouse's Files/, for the Fabric app `duckdb`.

    python scripts/upload_onelake.py <file> [<file> ...]

The same files import_data.yml builds for GitHub Pages (scripts/cache_catalog.py: mart_dim,
mart_today, mart_agg, mart_<YYYY>_h<N>), into Files/duckdb/ of the lakehouse WS_ID/LH_ID, and
then that folder's mart_manifest.json, written from what the folder holds (as the Pages
manifest is written from what the deploy repo holds). Each file is written under a temporary
name and renamed over the old one, so a reader never gets half a file.

Env: ONELAKE_TOKEN (a storage token), WS_ID, LH_ID; FILES_DIR (default Files/duckdb).
Standard library only: the job's venvs hold duckdb and nothing else.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request

HOST = "https://onelake.dfs.fabric.microsoft.com"
VERSION = "2023-11-03"
CHUNK = 32 * 1024 * 1024


def call(method, url, token, body=None, headers=None):
    req = urllib.request.Request(url, data=body, method=method, headers={
        "Authorization": f"Bearer {token}", "x-ms-version": VERSION, **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {url.split('?')[0]}: HTTP {e.code} {e.read()[:300]!r}") from None


def upload(path, ws, folder, name, token):
    tmp = f"{HOST}/{ws}/{folder}/{name}.uploading"
    call("PUT", f"{tmp}?resource=file", token, b"", {"Content-Length": "0"})
    pos = 0
    with open(path, "rb") as f:
        while chunk := f.read(CHUNK):
            call("PATCH", f"{tmp}?action=append&position={pos}", token, chunk,
                 {"Content-Length": str(len(chunk))})
            pos += len(chunk)
    call("PATCH", f"{tmp}?action=flush&position={pos}", token, b"", {"Content-Length": "0"})
    # Rename over the previous file: readers see the old one or the new one, never a part.
    call("PUT", f"{HOST}/{ws}/{folder}/{name}", token, b"",
         {"Content-Length": "0", "x-ms-rename-source": f"/{ws}/{folder}/{name}.uploading"})
    print(f"uploaded {name} ({pos / 1048576:.1f} MB)")


def main(files):
    token, ws, lh = os.environ["ONELAKE_TOKEN"], os.environ["WS_ID"], os.environ["LH_ID"]
    folder = f"{lh}/{os.environ.get('FILES_DIR', 'Files/duckdb').strip('/')}"
    call("PUT", f"{HOST}/{ws}/{folder}?resource=directory", token, b"", {"Content-Length": "0"})
    for path in files:
        upload(path, ws, folder, os.path.basename(path), token)
    # The manifest: the half-years the folder holds.
    _, body = call("GET", f"{HOST}/{ws}?resource=filesystem&directory={folder}&recursive=false", token)
    names = [p["name"].rsplit("/", 1)[-1] for p in json.loads(body).get("paths", [])]
    tags = sorted({m.group(1) for n in names if (m := re.fullmatch(r"mart_(\d{4}_h[12])\.duckdb", n))})
    if not tags:
        sys.exit("no mart_<YYYY>_h<N>.duckdb in the folder: not writing an empty manifest")
    manifest = os.path.join(os.path.dirname(os.path.abspath(files[0])) if files else ".", "mart_manifest.json")
    with open(manifest, "w") as f:
        json.dump({"periods": tags}, f)
    upload(manifest, ws, folder, "mart_manifest.json", token)
    print("manifest:", tags)


if __name__ == "__main__":
    main(sys.argv[1:])
