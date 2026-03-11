def model(dbt, session):
    dbt.config(materialized="incremental", unique_key=["source_type", "source_filename"], incremental_strategy="append", schema="landing")

    import os
    import io
    import sys
    import gzip
    import zipfile
    import tempfile
    import urllib.request
    from datetime import datetime
    from concurrent.futures import ThreadPoolExecutor, as_completed

    def log(msg):
        print(msg, file=sys.stderr, flush=True)

    import csv as csv_mod

    csv_archive_path = os.environ.get("ROOT_PATH", "/tmp") + "/Files/csv"
    download_limit = int(os.environ.get("download_limit", "2"))
    batch_size = 7
    max_workers = 8
    pending_entries = []  # non-duid entries deferred until fact tables confirm

    # =========================================================================
    # Load existing log from Iceberg table (incremental) or start fresh
    # =========================================================================
    if dbt.is_incremental:
        session.sql(f"""
            CREATE OR REPLACE TEMP TABLE _csv_archive_log AS
            SELECT source_type, source_filename, archive_path, archived_at,
                   row_count, source_url, etag, csv_filename
            FROM {dbt.this}
        """)
    else:
        session.sql("""
            CREATE OR REPLACE TEMP TABLE _csv_archive_log (
                source_type VARCHAR, source_filename VARCHAR,
                archive_path VARCHAR, archived_at TIMESTAMP,
                row_count BIGINT, source_url VARCHAR, etag VARCHAR,
                csv_filename VARCHAR
            )
        """)

    # Get existing source_filenames for dedup
    existing = set()
    for row in session.sql(
        "SELECT source_type || '::' || source_filename FROM _csv_archive_log"
    ).fetchall():
        existing.add(row[0])

    # Track new rows added this run
    session.sql("""
        CREATE OR REPLACE TEMP TABLE _new_log_rows (
            source_type VARCHAR, source_filename VARCHAR,
            archive_path VARCHAR, archived_at TIMESTAMP,
            row_count BIGINT, source_url VARCHAR, etag VARCHAR,
            csv_filename VARCHAR
        )
    """)

    # =========================================================================
    # Helper: download ZIP, extract CSVs to temp dir
    # =========================================================================
    def download_and_extract(url, temp_dir):
        """Download ZIP from url, extract CSV files to temp_dir. Thread-safe."""
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (dbt-aemo)"})
        for attempt in range(3):
            try:
                zip_bytes = urllib.request.urlopen(req, timeout=60).read()
                break
            except urllib.error.HTTPError as e:
                if attempt < 2:
                    import time; time.sleep(2 ** attempt)
                    continue
                raise
        z = zipfile.ZipFile(io.BytesIO(zip_bytes))
        results = []
        for name in z.namelist():
            if name.upper().endswith(".CSV"):
                safe_name = name.replace("/", "_")
                gz_name = safe_name + ".gz"
                gz_path = os.path.join(temp_dir, gz_name)
                with gzip.open(gz_path, "wb") as f:
                    f.write(z.read(name))
                results.append((name, gz_name, gz_path))
        return results

    def process_downloads(rows, source_type, subfolder):
        """Download, extract, store locally in batches."""
        files_to_process = [(row[0], row[1]) for row in rows]
        for i in range(0, len(files_to_process), batch_size):
            batch = files_to_process[i:i + batch_size]
            with tempfile.TemporaryDirectory() as tmpdir:
                extracted = []
                with ThreadPoolExecutor(max_workers=max_workers) as executor:
                    future_to_meta = {
                        executor.submit(download_and_extract, url, tmpdir): (url, src_fn)
                        for url, src_fn in batch
                    }
                    for future in as_completed(future_to_meta):
                        url, src_fn = future_to_meta[future]
                        try:
                            for csv_name, safe_name, temp_path in future.result():
                                extracted.append((src_fn, safe_name, temp_path, url))
                        except Exception as e:
                            log(f"WARN: skipping {src_fn}: {e}")

                now = datetime.now().isoformat()
                for src_fn, csv_name, temp_path, url in extracted:
                    csv_base = csv_name.removesuffix(".gz").removesuffix(".CSV").removesuffix(".csv")
                    dest = f"{csv_archive_path}/{subfolder}/{csv_name}"
                    dest_dir = dest.rsplit("/", 1)[0]
                    os.makedirs(dest_dir, exist_ok=True)
                    import shutil
                    shutil.copy2(temp_path, dest)
                    # Insert into in-memory log for dedup within this run
                    session.sql(f"""
                        INSERT INTO _csv_archive_log VALUES (
                            '{source_type}', '{src_fn}', '/{subfolder}/{csv_name}',
                            '{now}'::TIMESTAMP, NULL, '{url}', NULL, '{csv_base}'
                        )
                    """)
                    # Defer writing to Iceberg until fact tables confirm processing
                    pending_entries.append((source_type, src_fn, f'/{subfolder}/{csv_name}',
                                           now, url, csv_base))

    # =========================================================================
    # DAILY REPORTS (SCADA + PRICE)
    # =========================================================================

    # Fetch file listing from AEMO
    session.sql("""
        CREATE OR REPLACE TEMP TABLE daily_files_web AS
        WITH
          html_data AS (
            SELECT content AS html
            FROM read_text('https://nemweb.com.au/Reports/Current/Daily_Reports/')
          ),
          lines AS (
            SELECT unnest(string_split(html, '<br>')) AS line FROM html_data
          )
        SELECT
          'https://nemweb.com.au' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
          split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
        FROM lines
        WHERE line LIKE '%PUBLIC_DAILY%.zip%'
    """)

    # Check if AEMO has enough new files before hitting GitHub
    aemo_new = session.sql(f"""
        SELECT count(*) FROM daily_files_web
        WHERE 'daily::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
    """).fetchone()[0]

    if aemo_new < download_limit:
        # Backfill from GitHub
        session.sql("""
            INSERT INTO daily_files_web
            WITH
              api_responses AS (
                SELECT 2018 AS year, content AS json_content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2018')
                UNION ALL SELECT 2019, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2019')
                UNION ALL SELECT 2020, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2020')
                UNION ALL SELECT 2021, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2021')
                UNION ALL SELECT 2022, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2022')
                UNION ALL SELECT 2023, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2023')
                UNION ALL SELECT 2024, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2024')
                UNION ALL SELECT 2025, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2025')
                UNION ALL SELECT 2026, content FROM read_text('https://api.github.com/repos/djouallah/fabric_demo/contents/data/archive/2026')
              ),
              parsed_files AS (
                SELECT year, unnest(from_json(json_content, '["json"]')) AS file_info
                FROM api_responses
              )
            SELECT
              json_extract_string(file_info, '$.download_url') AS full_url,
              split_part(json_extract_string(file_info, '$.name'), '.', 1) AS filename
            FROM parsed_files
            WHERE json_extract_string(file_info, '$.name') LIKE 'PUBLIC_DAILY%.zip'
              AND split_part(json_extract_string(file_info, '$.name'), '.', 1)
                  NOT IN (SELECT filename FROM daily_files_web)
        """)

    # Get new daily files to download
    daily_to_download = session.sql(f"""
        SELECT full_url, filename FROM daily_files_web
        WHERE 'daily::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
        LIMIT {download_limit}
    """).fetchall()

    log(f"Daily files: {len(daily_to_download)} new")
    if daily_to_download:
        process_downloads(daily_to_download, 'daily', 'daily')

    # =========================================================================
    # INTRADAY SCADA
    # =========================================================================

    session.sql("""
        CREATE OR REPLACE TEMP TABLE intraday_scada_web AS
        WITH
          html_data AS (
            SELECT content AS html
            FROM read_text('http://nemweb.com.au/Reports/Current/Dispatch_SCADA/')
          ),
          lines AS (
            SELECT unnest(string_split(html, '<br>')) AS line FROM html_data
          )
        SELECT
          'http://nemweb.com.au' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
          split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
        FROM lines
        WHERE line LIKE '%PUBLIC_DISPATCHSCADA%'
        ORDER BY full_url DESC
        LIMIT 500
    """)

    scada_to_download = session.sql(f"""
        SELECT full_url, filename FROM intraday_scada_web
        WHERE 'scada_today::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
        LIMIT {download_limit}
    """).fetchall()

    log(f"Intraday SCADA files: {len(scada_to_download)} new")
    if scada_to_download:
        process_downloads(scada_to_download, 'scada_today', 'scada_today')

    # =========================================================================
    # INTRADAY PRICE
    # =========================================================================

    session.sql("""
        CREATE OR REPLACE TEMP TABLE intraday_price_web AS
        WITH
          html_data AS (
            SELECT content AS html
            FROM read_text('http://nemweb.com.au/Reports/Current/DispatchIS_Reports/')
          ),
          lines AS (
            SELECT unnest(string_split(html, '<br>')) AS line FROM html_data
          )
        SELECT
          'http://nemweb.com.au' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
          split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
        FROM lines
        WHERE line LIKE '%PUBLIC_DISPATCHIS_%.zip%'
        ORDER BY full_url DESC
        LIMIT 500
    """)

    price_to_download = session.sql(f"""
        SELECT full_url, filename FROM intraday_price_web
        WHERE 'price_today::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
        LIMIT {download_limit}
    """).fetchall()

    log(f"Intraday Price files: {len(price_to_download)} new")
    if price_to_download:
        process_downloads(price_to_download, 'price_today', 'price_today')

    # =========================================================================
    # DUID REFERENCE DATA (skip if downloaded less than 24 hours ago)
    # =========================================================================

    duid_sources = [
        (
            "duid_data",
            "duid_data",
            "https://raw.githubusercontent.com/djouallah/aemo_fabric/refs/heads/djouallah-patch-1/duid_data.csv",
            "duid_data.csv",
        ),
        (
            "duid_facilities",
            "facilities",
            "https://data.wa.aemo.com.au/datafiles/post-facilities/facilities.csv",
            "facilities.csv",
        ),
        (
            "duid_wa_energy",
            "WA_ENERGY",
            "https://raw.githubusercontent.com/djouallah/aemo_fabric/refs/heads/main/WA_ENERGY.csv",
            "WA_ENERGY.csv",
        ),
        (
            "duid_geo_data",
            "geo_data",
            "https://raw.githubusercontent.com/djouallah/aemo_fabric/refs/heads/main/geo_data.csv",
            "geo_data.csv",
        ),
    ]

    # Check if DUID data was downloaded recently (< 24 hours ago)
    last_duid_download = session.sql("""
        SELECT max(archived_at) FROM _csv_archive_log
        WHERE source_type LIKE 'duid_%'
    """).fetchone()[0]

    # Also check if local files exist (ephemeral runners won't have them)
    duid_files_exist = all(
        os.path.exists(f"{csv_archive_path}/duid/{csv_fn}")
        for _, _, _, csv_fn in duid_sources
    )
    skip_duid = (
        duid_files_exist
        and last_duid_download is not None
        and (datetime.now() - last_duid_download).total_seconds() < 86400
    )

    if skip_duid:
        log(f"DUID data is fresh (last download: {last_duid_download}), skipping")
    else:
        duid_dir = f"{csv_archive_path}/duid"
        os.makedirs(duid_dir, exist_ok=True)

        duid_downloaded = []
        for source_type, source_filename, url, csv_filename in duid_sources:
            local_path = f"{csv_archive_path}/duid/{csv_filename}"
            try:
                session.sql(f"""
                    COPY (
                        SELECT * FROM read_csv_auto('{url}',
                            null_padding=true, ignore_errors=true
                            {", header=true" if source_filename == "WA_ENERGY" else ""})
                    ) TO ('{local_path}') (FORMAT CSV, HEADER)
                """)
                duid_downloaded.append((source_type, source_filename, url, csv_filename))
            except Exception as e:
                if os.path.exists(local_path):
                    log(f"WARN: {source_filename} download failed, using existing local file: {e}")
                else:
                    raise

        # Delete old DUID log entries and re-insert for successfully downloaded files
        if duid_downloaded:
            for st, sf, _, _ in duid_downloaded:
                session.sql(f"DELETE FROM _csv_archive_log WHERE source_type = '{st}'")
            now = datetime.now().isoformat()
            for source_type, source_filename, url, csv_filename in duid_downloaded:
                csv_base = csv_filename.rsplit(".", 1)[0]
                session.sql(f"""
                    INSERT INTO _csv_archive_log VALUES (
                        '{source_type}', '{source_filename}',
                        '/duid/{csv_filename}', '{now}'::TIMESTAMP,
                        NULL, '{url}', NULL, '{csv_base}'
                    )
                """)
                session.sql(f"""
                    INSERT INTO _new_log_rows VALUES (
                        '{source_type}', '{source_filename}',
                        '/duid/{csv_filename}', '{now}'::TIMESTAMP,
                        NULL, '{url}', NULL, '{csv_base}'
                    )
                """)

    # =========================================================================
    # Save pending entries to temp file for confirm_log_entries macro
    # =========================================================================
    if pending_entries:
        pending_path = os.environ.get("ROOT_PATH", "/tmp") + "/pending_log_entries.csv"
        with open(pending_path, "w", newline="") as f:
            w = csv_mod.writer(f)
            w.writerow(["source_type", "source_filename", "archive_path",
                        "archived_at", "source_url", "csv_filename"])
            for st, sf, ap, at, url, cf in pending_entries:
                w.writerow([st, sf, ap, at, url, cf])
        log(f"Wrote {len(pending_entries)} pending log entries to {pending_path}")

    # =========================================================================
    # Return: new rows only (incremental) or all rows (full refresh)
    # =========================================================================
    result_table = "_new_log_rows" if dbt.is_incremental else "_csv_archive_log"
    return session.sql(f"SELECT * FROM {result_table}")
