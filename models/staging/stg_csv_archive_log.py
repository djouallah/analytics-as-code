def model(dbt, session):
    dbt.config(materialized="incremental", incremental_strategy="append", schema="landing")

    import os
    import io
    import time
    import gzip
    import zipfile
    import tempfile
    import urllib.error
    import urllib.request
    from datetime import datetime, timezone
    from concurrent.futures import ThreadPoolExecutor, as_completed

    root_path = os.environ.get("FILES_PATH", "/tmp")
    csv_archive_path = root_path + "/csv"
    csv_log_path = root_path + "/csv_archive_log.parquet"
    download_limit = int(os.environ.get("download_limit", "2"))
    batch_size = 7
    max_workers = 8

    # =========================================================================
    # Load existing log
    # =========================================================================
    log_exists = session.sql(
        f"SELECT count(*) FROM glob('{csv_log_path}')"
    ).fetchone()[0]

    if log_exists > 0:
        # Check if csv_filename column exists in existing parquet
        cols = [row[0] for row in session.sql(
            f"DESCRIBE SELECT * FROM read_parquet('{csv_log_path}')"
        ).fetchall()]
        has_csv_filename = "csv_filename" in cols

        if has_csv_filename:
            session.sql(f"""
                CREATE OR REPLACE TEMP TABLE _csv_archive_log AS
                SELECT source_type, source_filename, archive_path, archived_at,
                       row_count, source_url, etag, csv_filename
                FROM read_parquet('{csv_log_path}')
                WHERE csv_filename IS NOT NULL
            """)
        else:
            # Old-format log without csv_filename — start fresh
            session.sql("""
                CREATE OR REPLACE TEMP TABLE _csv_archive_log (
                    source_type VARCHAR, source_filename VARCHAR,
                    archive_path VARCHAR, archived_at TIMESTAMPTZ,
                    row_count BIGINT, source_url VARCHAR, etag VARCHAR,
                    csv_filename VARCHAR
                )
            """)
    else:
        session.sql("""
            CREATE OR REPLACE TEMP TABLE _csv_archive_log (
                source_type VARCHAR, source_filename VARCHAR,
                archive_path VARCHAR, archived_at TIMESTAMPTZ,
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
        # Retry what is transient (5xx, 429, timeouts, connection resets); a 4xx such as a
        # 404 will not change on a retry, so it fails straight away.
        for attempt in range(3):
            try:
                zip_bytes = urllib.request.urlopen(req, timeout=60).read()
                break
            except urllib.error.HTTPError as e:
                if attempt < 2 and (e.code >= 500 or e.code == 429):
                    time.sleep(2 ** attempt)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError):
                if attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise
        z = zipfile.ZipFile(io.BytesIO(zip_bytes))
        results = []
        nested = []
        for name in z.namelist():
            if name.upper().endswith(".CSV"):
                # '#': the monthly archive's member names carry it since 2024-08.
                safe_name = name.replace("/", "_").replace("#", "_")
                gz_name = safe_name + ".gz"
                gz_path = os.path.join(temp_dir, gz_name)
                with gzip.open(gz_path, "wb") as f:
                    f.write(z.read(name))
                results.append((name, gz_name, gz_path))
            elif name.upper().endswith(".ZIP"):
                inner = zipfile.ZipFile(io.BytesIO(z.read(name)))
                nested.extend(inner.read(n) for n in inner.namelist() if n.upper().endswith(".CSV"))
        if nested:
            # A weekly archive is a zip of several hundred one-interval zips: their CSVs are
            # kept as one file named after the archive. Each keeps its own C and I rows,
            # which the readers filter on anyway.
            csv_name = url.rsplit("/", 1)[-1].rsplit(".", 1)[0] + ".CSV"
            gz_path = os.path.join(temp_dir, csv_name + ".gz")
            with gzip.open(gz_path, "wb") as f:
                f.write(b"\n".join(nested))
            results.append((csv_name, csv_name + ".gz", gz_path))
        return results

    def mmsdm_url(table, year, month):
        """A table's monthly file in AEMO's MMSDM archive. The file name changed in 2024-08."""
        stamp = f"{year}{month:02d}010000"
        name = (f"PUBLIC_DVD_{table}_{stamp}" if (year, month) < (2024, 8)
                else f"PUBLIC_ARCHIVE%23{table}%23FILE01%23{stamp}")
        return ("https://nemweb.com.au/Data_Archive/Wholesale_Electricity/MMSDM/"
                f"{year}/MMSDM_{year}_{month:02d}/MMSDM_Historical_Data_SQLLoader/DATA/{name}.zip")

    def months_to_download(table, source_type):
        """(url, source_filename) of the months 2018-01 to 2026-08 the log doesn't have yet,
        newest first. A finite backfill: every URL in that range was checked on 2026-10-02."""
        archived = {row[0] for row in session.sql(f"""
            SELECT source_filename FROM _csv_archive_log WHERE source_type = '{source_type}'
        """).fetchall()}
        months = sorted(((y, m) for y in range(2018, 2027) for m in range(1, 13) if (y, m) <= (2026, 8)),
                        reverse=True)
        return [(mmsdm_url(table, y, m), f"{table}_{y}{m:02d}010000") for y, m in months
                if f"{table}_{y}{m:02d}010000" not in archived]

    def copy_to_onelake(temp_path, dest_path):
        """Copy a local file to OneLake via DuckDB COPY."""
        escaped_temp = temp_path.replace("\\", "/")
        if not dest_path.startswith(("az://", "abfss://")):
            dest_dir = dest_path.rsplit("/", 1)[0]
            os.makedirs(dest_dir, exist_ok=True)
        session.sql(
            f"COPY (SELECT content FROM read_blob('{escaped_temp}')) "
            f"TO '{dest_path}' (FORMAT BLOB, COMPRESSION 'none')"
        )

    def save_log():
        """Save current log state to parquet."""
        session.sql(f"COPY _csv_archive_log TO '{csv_log_path}' (FORMAT PARQUET)")

    def process_downloads(rows, source_type, subfolder):
        """Download, extract, copy to OneLake in batches. Saves log after each batch."""
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
                            print(f"  WARN: skipping {src_fn}: {e}")

                now = datetime.now(timezone.utc).isoformat()
                for src_fn, csv_name, temp_path, url in extracted:
                    csv_base = csv_name.removesuffix(".gz").removesuffix(".CSV").removesuffix(".csv")
                    dest = f"{csv_archive_path}/{subfolder}/{csv_name}"
                    copy_to_onelake(temp_path, dest)
                    # Parameterized so odd characters in filenames/URLs can't break the SQL
                    session.execute(
                        "INSERT INTO _csv_archive_log VALUES "
                        "(?, ?, ?, CAST(? AS TIMESTAMPTZ), NULL, ?, NULL, ?)",
                        [source_type, src_fn, f"/{subfolder}/{csv_name}", now, url, csv_base],
                    )
            save_log()

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
        # Authenticated GitHub API calls get 5000 req/h vs 60 anonymous — shared CI
        # runner IPs exhaust the anonymous quota and the listing calls fail.
        github_token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if github_token:
            session.sql(f"""
                CREATE OR REPLACE SECRET github_api (
                    TYPE HTTP,
                    BEARER_TOKEN '{github_token}',
                    SCOPE 'https://api.github.com'
                )
            """)
        # Backfill from GitHub — opportunistic: if the listing API is unavailable
        # (rate limit, outage), continue with the AEMO current files only. One listing
        # per year, each on its own: the years run up to the current one, and a year
        # whose archive directory doesn't exist yet (early January) must not take the
        # older years down with it.
        for year in range(2018, datetime.now(timezone.utc).year + 1):
            try:
                session.sql(f"""
                    INSERT INTO daily_files_web
                    WITH parsed_files AS (
                      SELECT unnest(from_json(content, '["json"]')) AS file_info
                      FROM read_text('https://api.github.com/repos/djouallah/aemo_data/contents/data/archive/{year}')
                    )
                    SELECT
                      json_extract_string(file_info, '$.download_url') AS full_url,
                      split_part(json_extract_string(file_info, '$.name'), '.', 1) AS filename
                    FROM parsed_files
                    WHERE json_extract_string(file_info, '$.name') LIKE 'PUBLIC_DAILY%.zip'
                      AND split_part(json_extract_string(file_info, '$.name'), '.', 1)
                          NOT IN (SELECT filename FROM daily_files_web)
                """)
            except Exception as e:
                print(f"  WARN: GitHub backfill listing for {year} unavailable, skipping it: {e}")

    # Get new daily files to download
    daily_to_download = session.sql(f"""
        SELECT full_url, filename FROM daily_files_web
        WHERE 'daily::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
        LIMIT {download_limit}
    """).fetchall()

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

    if price_to_download:
        process_downloads(price_to_download, 'price_today', 'price_today')

    # =========================================================================
    # INTERCONNECTOR HISTORY (AEMO's monthly archive, a finite backfill)
    # =========================================================================

    # The DispatchIS files above are only archived from 2026-08. AEMO's monthly MMSDM
    # archive holds the same INTERCONNECTORRES record, one zip a month: 2018-01 to 2026-08
    # is what fct_interconnector_today needs to go back as far as the other facts.
    # Newest months first, and like the GitHub backfill only once the daily feed has caught
    # up. When every month is in the log there is nothing left to do here.
    if aemo_new < download_limit:
        interconnector_months = months_to_download('DISPATCHINTERCONNECTORRES', 'interconnector_monthly')
        if interconnector_months:
            process_downloads(interconnector_months[:download_limit],
                              'interconnector_monthly', 'interconnector_monthly')

    # =========================================================================
    # ROOFTOP SOLAR (AEMO's half-hourly estimate per region)
    # =========================================================================

    # Not metered: AEMO estimates each region's rooftop output every half hour and publishes
    # it as ROOFTOP_PV_ACTUAL, one small file per interval and estimate type. MEASUREMENT
    # (scaled up from sampled systems) is the one used; SATELLITE runs lower and is left out.
    # The current folder holds two weeks.
    session.sql("""
        CREATE OR REPLACE TEMP TABLE rooftop_web AS
        WITH
          html_data AS (
            SELECT content AS html
            FROM read_text('https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/')
          ),
          lines AS (
            SELECT unnest(string_split(html, '<br>')) AS line FROM html_data
          )
        SELECT
          'https://nemweb.com.au' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
          split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
        FROM lines
        WHERE line LIKE '%PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_%.zip%'
        ORDER BY full_url DESC
        LIMIT 700
    """)

    rooftop_to_download = session.sql(f"""
        SELECT full_url, filename FROM rooftop_web
        WHERE 'rooftop_today::' || filename NOT IN (
            SELECT source_type || '::' || source_filename FROM _csv_archive_log
        )
        LIMIT {download_limit}
    """).fetchall()

    if rooftop_to_download:
        process_downloads(rooftop_to_download, 'rooftop_today', 'rooftop_today')

    # History, once the daily feed has caught up: the monthly archive of the same table from
    # 2018-01 to 2026-08 (every estimate type; MEASUREMENT starts 2018-03-06), then AEMO's
    # weekly archives from the one that reaches into September 2026. The weekly files keep
    # coming, one a week, and repeat what the current folder gave: that is what refills a
    # stretch the pipeline missed for more than two weeks. Readers take one row per interval.
    if aemo_new < download_limit:
        rooftop_months = months_to_download('ROOFTOP_PV_ACTUAL', 'rooftop_monthly')
        if rooftop_months:
            process_downloads(rooftop_months[:download_limit], 'rooftop_monthly', 'rooftop_monthly')

        rooftop_weeks = session.sql(f"""
            WITH
              html_data AS (
                SELECT content AS html
                FROM read_text('https://nemweb.com.au/Reports/Archive/ROOFTOP_PV/ACTUAL/')
              ),
              lines AS (
                SELECT unnest(string_split(html, '<br>')) AS line FROM html_data
              ),
              weeks AS (
                SELECT
                  'https://nemweb.com.au' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
                  split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
                FROM lines
                WHERE line LIKE '%PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_%.zip%'
              )
            SELECT full_url, filename FROM weeks
            WHERE filename >= 'PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260827'
              AND 'rooftop_weekly::' || filename NOT IN (
                SELECT source_type || '::' || source_filename FROM _csv_archive_log
              )
            ORDER BY filename DESC
            LIMIT {download_limit}
        """).fetchall()
        if rooftop_weeks:
            process_downloads(rooftop_weeks, 'rooftop_weekly', 'rooftop_weekly')

    # =========================================================================
    # DUID REFERENCE DATA (skip if downloaded less than 24 hours ago)
    # =========================================================================

    duid_sources = [
        # The units in the data that AEMO's registration list (below) doesn't have: closed
        # plant, DUIDs replaced by new ones, non-scheduled units. Generated from AEMO's MMSDM
        # registration history; its commits in aemo_data say how.
        (
            "duid_unregistered",
            "duid_unregistered",
            "https://raw.githubusercontent.com/djouallah/aemo_data/refs/heads/main/duid_unregistered.csv",
            "duid_unregistered.csv",
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
            "https://raw.githubusercontent.com/djouallah/aemo_data/refs/heads/main/WA_ENERGY.csv",
            "WA_ENERGY.csv",
        ),
        (
            "duid_geo_data",
            "geo_data",
            "https://raw.githubusercontent.com/djouallah/aemo_data/refs/heads/main/geo_data.csv",
            "geo_data.csv",
        ),
    ]

    # Check if DUID data was downloaded recently (< 24 hours ago)
    last_duid_download = session.sql("""
        SELECT max(archived_at) FROM _csv_archive_log
        WHERE source_type LIKE 'duid_%'
    """).fetchone()[0]

    # Also refresh at once if the log lacks one of the two files dim_duid reads its NEM
    # units from: the registration list (a failed download leaves it out of the log, so
    # the next run tries again) or duid_unregistered.csv (added 2026-10-03).
    has_nem_units_log = session.sql("""
        SELECT count(DISTINCT source_type) FROM _csv_archive_log
        WHERE source_type IN ('duid_registration', 'duid_unregistered')
    """).fetchone()[0] == 2
    skip_duid = (
        last_duid_download is not None
        and has_nem_units_log
        and (datetime.now(last_duid_download.tzinfo) - last_duid_download).total_seconds() < 86400
    )

    if skip_duid:
        print(f"  DUID data is fresh (last download: {last_duid_download}), skipping")
    else:
        duid_dir = f"{csv_archive_path}/duid"
        if not duid_dir.startswith(("az://", "abfss://")):
            os.makedirs(duid_dir, exist_ok=True)

        for source_type, source_filename, url, csv_filename in duid_sources:
            session.sql(f"""
                COPY (
                    SELECT * FROM read_csv_auto('{url}',
                        null_padding=true, ignore_errors=true
                        {", header=true" if source_filename == "WA_ENERGY" else ""})
                ) TO ('{csv_archive_path}/duid/{csv_filename}') (FORMAT CSV, HEADER)
            """)

        # AEMO's NEM Registration and Exemption List, as archived weekly by
        # djouallah/aemo_data (data/duid/registration/<name>_<YYYYMMDD>.xls, really an
        # .xlsx): the newest one's generator sheet is saved as registration.csv, which
        # dim_duid reads. When this fails the previous registration.csv stays in place.
        try:
            import json
            api = "https://api.github.com/repos/djouallah/aemo_data/contents/data/duid/registration"
            headers = {"User-Agent": "dbt-aemo"}
            token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
            if token:
                headers["Authorization"] = f"Bearer {token}"
            listing = json.loads(urllib.request.urlopen(
                urllib.request.Request(api, headers=headers), timeout=60).read())
            latest = max((f for f in listing if f["name"].startswith("NEM-Registration")),
                         key=lambda f: f["name"])
            xlsx_bytes = urllib.request.urlopen(latest["download_url"], timeout=120).read()
            with tempfile.TemporaryDirectory() as tmp:
                xlsx_path = os.path.join(tmp, "registration.xlsx").replace("\\", "/")
                with open(xlsx_path, "wb") as f:
                    f.write(xlsx_bytes)
                session.sql("INSTALL excel; LOAD excel;")
                session.sql(f"""
                    COPY (
                        SELECT * FROM read_xlsx('{xlsx_path}', sheet = 'PU and Scheduled Loads',
                                                all_varchar = true)
                        WHERE DUID IS NOT NULL
                    ) TO ('{csv_archive_path}/duid/registration.csv') (FORMAT CSV, HEADER)
                """)
            duid_sources.append(("duid_registration", latest["name"].rsplit(".", 1)[0],
                                 latest["download_url"], "registration.csv"))
            print(f"  DUID registration list: {latest['name']}")
        except Exception as e:
            print(f"  WARN: AEMO registration list unavailable, keeping the previous registration.csv: {e}")

        # Delete old DUID log entries and re-insert
        session.sql("DELETE FROM _csv_archive_log WHERE source_type LIKE 'duid_%'")
        now = datetime.now(timezone.utc).isoformat()
        for source_type, source_filename, url, csv_filename in duid_sources:
            csv_base = csv_filename.rsplit(".", 1)[0]
            session.execute(
                "INSERT INTO _csv_archive_log VALUES "
                "(?, ?, ?, CAST(? AS TIMESTAMPTZ), NULL, ?, NULL, ?)",
                [source_type, source_filename, f"/duid/{csv_filename}", now, url, csv_base],
            )

    # =========================================================================
    # Save log to parquet and return
    # =========================================================================
    save_log()

    # The parquet above is the durable log; the Iceberg table is a materialization of it
    # that the fact pre-hooks read. Append only the rows the table is missing. Returning
    # the whole log every run (the original version) made the table grow by its own size
    # 48 times a day: by 2026-09-17 the OneLake catalog answered HTTP 500 to every load
    # and commit of it and the pipeline was down until the table was rebuilt.
    # Anti-join, not "what this run downloaded": a run that saves the parquet and then
    # fails to commit (the 2026-09-17 failure mode) must be repaired by the next run, not
    # leave those files invisible to the facts forever.
    if dbt.is_incremental:
        session.sql(f"""
            CREATE OR REPLACE TEMP TABLE _log_delta AS
            SELECT l.*
            FROM _csv_archive_log l
            WHERE NOT EXISTS (
                SELECT 1 FROM {dbt.this} t
                WHERE t.source_type = l.source_type
                  AND t.source_filename = l.source_filename
                  AND t.csv_filename = l.csv_filename
            )
        """)
        n = session.sql("SELECT count(*) FROM _log_delta").fetchone()[0]
        print(f"  {n} log rows not yet in {dbt.this}, appending")
        return session.sql("SELECT * FROM _log_delta")

    return session.sql("SELECT * FROM _csv_archive_log")
