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
    from datetime import datetime, timedelta, timezone
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
            # Never start an empty log over this one: it would be saved over the durable
            # log, the only source of truth, and every file downloaded again.
            raise RuntimeError(
                f"{csv_log_path} has no csv_filename column ({', '.join(cols)}); "
                "refusing to replace the archive log"
            )
    else:
        session.sql("""
            CREATE OR REPLACE TEMP TABLE _csv_archive_log (
                source_type VARCHAR, source_filename VARCHAR,
                archive_path VARCHAR, archived_at TIMESTAMPTZ,
                row_count BIGINT, source_url VARCHAR, etag VARCHAR,
                csv_filename VARCHAR
            )
        """)
    # What the log held when loaded: the end of the run saves it only if this has changed.
    log_state = session.sql("SELECT count(*), max(archived_at) FROM _csv_archive_log").fetchone()

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

    def warn(msg):
        """A warning on the workflow run's page (a plain print is buried in the log)."""
        print(f"::warning::{msg}")

    def list_nemweb(table, url, like, limit=None):
        """TEMP TABLE `table` (full_url, filename): the zips a nemweb folder lists whose line
        matches `like`, the newest `limit` of them when capped. True if the folder answered.

        A folder that doesn't answer (nemweb down, a folder AEMO has removed) leaves the table
        empty: that feed downloads nothing this run, and the other feeds and the fact models'
        backlog carry on. Raising here would fail this model and skip every fact with it."""
        host = "/".join(url.split("/", 3)[:3])
        try:
            session.sql(f"""
                CREATE OR REPLACE TEMP TABLE {table} AS
                WITH
                  html_data AS (SELECT content AS html FROM read_text('{url}')),
                  lines AS (SELECT unnest(string_split(html, '<br>')) AS line FROM html_data)
                SELECT
                  '{host}' || regexp_extract(line, 'HREF="([^"]+)"', 1) AS full_url,
                  split_part(regexp_extract(line, 'HREF="[^"]+/([^"]+\\.zip)"', 1), '.', 1) AS filename
                FROM lines
                WHERE line LIKE '{like}'
                {f"ORDER BY full_url DESC LIMIT {limit}" if limit else ""}
            """)
            return True
        except Exception as e:
            warn(f"{url} could not be listed, nothing downloaded from it this run: {e}")
            session.sql(f"CREATE OR REPLACE TEMP TABLE {table} (full_url VARCHAR, filename VARCHAR)")
            return False

    def not_archived(source_type):
        """WHERE fragment over a listing `w`: the log has no such file of this source type.
        NOT EXISTS, not NOT IN: one NULL in the log would turn NOT IN into "never true"."""
        return (f"NOT EXISTS (SELECT 1 FROM _csv_archive_log l "
                f"WHERE l.source_type = '{source_type}' AND l.source_filename = w.filename)")

    def to_download(table, source_type, where="TRUE"):
        """(full_url, filename) of the listed files the log doesn't have, newest first."""
        return session.sql(f"""
            SELECT full_url, filename FROM {table} w
            WHERE {where} AND {not_archived(source_type)}
            ORDER BY filename DESC
            LIMIT {download_limit}
        """).fetchall()

    # =========================================================================
    # DAILY REPORTS (SCADA + PRICE)
    # =========================================================================

    # AEMO publishes one next-day file a day, for the trading day before (about 04:05
    # Brisbane). Once the log has yesterday's, there is nothing to list until tomorrow's:
    # the folder is not asked, and the backfills below, which wait for the daily feed's
    # listing, wait with it: they run on the runs between midnight and the new file.
    newest_daily = session.sql("""
        SELECT max(substr(source_filename, 14, 8)) FROM _csv_archive_log
        WHERE source_type = 'daily' AND source_filename LIKE 'PUBLIC_DAILY_%'
    """).fetchone()[0]
    yesterday = (datetime.now(timezone(timedelta(hours=10))) - timedelta(days=1)).strftime("%Y%m%d")
    if newest_daily and newest_daily >= yesterday:
        print(f"  daily: the log has the file of {newest_daily}, nothing new before the next one; not listed")
        session.sql("CREATE OR REPLACE TEMP TABLE daily_files_web (full_url VARCHAR, filename VARCHAR)")
        daily_listed = False
    else:
        daily_listed = list_nemweb('daily_files_web', 'https://nemweb.com.au/Reports/Current/Daily_Reports/',
                                   '%PUBLIC_DAILY%.zip%')

    # Check if AEMO has enough new files before hitting GitHub
    aemo_new = session.sql(f"""
        SELECT count(*) FROM daily_files_web w WHERE {not_archived('daily')}
    """).fetchone()[0]
    # The backfills below wait for the daily feed to have caught up; a listing that failed,
    # or that was not needed, says nothing about that, so they wait for the next run too.
    caught_up = daily_listed and aemo_new < download_limit

    if caught_up:
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
                      AND NOT EXISTS (
                        SELECT 1 FROM daily_files_web w
                        WHERE w.filename = split_part(json_extract_string(file_info, '$.name'), '.', 1))
                """)
            except Exception as e:
                print(f"  WARN: GitHub backfill listing for {year} unavailable, skipping it: {e}")

    # Get new daily files to download
    daily_to_download = to_download('daily_files_web', 'daily')

    if daily_to_download:
        process_downloads(daily_to_download, 'daily', 'daily')

    # =========================================================================
    # INTRADAY SCADA
    # =========================================================================

    list_nemweb('intraday_scada_web', 'http://nemweb.com.au/Reports/Current/Dispatch_SCADA/',
                '%PUBLIC_DISPATCHSCADA%', limit=500)

    scada_to_download = to_download('intraday_scada_web', 'scada_today')

    if scada_to_download:
        process_downloads(scada_to_download, 'scada_today', 'scada_today')

    # =========================================================================
    # INTRADAY PRICE
    # =========================================================================

    list_nemweb('intraday_price_web', 'http://nemweb.com.au/Reports/Current/DispatchIS_Reports/',
                '%PUBLIC_DISPATCHIS_%.zip%', limit=500)

    price_to_download = to_download('intraday_price_web', 'price_today')

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
    if caught_up:
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
    # The current folder holds two weeks. AEMO has said this record is to be removed (see
    # fct_rooftop_pv.sql): when the folder goes, list_nemweb warns and the other feeds go on.
    list_nemweb('rooftop_web', 'https://nemweb.com.au/Reports/Current/ROOFTOP_PV/ACTUAL/',
                '%PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_%.zip%', limit=700)

    rooftop_to_download = to_download('rooftop_web', 'rooftop_today')

    if rooftop_to_download:
        process_downloads(rooftop_to_download, 'rooftop_today', 'rooftop_today')

    # History, once the daily feed has caught up: the monthly archive of the same table from
    # 2018-01 to 2026-08 (every estimate type; MEASUREMENT starts 2018-03-06), then AEMO's
    # weekly archives from the one that reaches into September 2026. The weekly files keep
    # coming, one a week, and repeat what the current folder gave: that is what refills a
    # stretch the pipeline missed for more than two weeks. Readers take one row per interval.
    if caught_up:
        rooftop_months = months_to_download('ROOFTOP_PV_ACTUAL', 'rooftop_monthly')
        if rooftop_months:
            process_downloads(rooftop_months[:download_limit], 'rooftop_monthly', 'rooftop_monthly')

        list_nemweb('rooftop_weeks_web', 'https://nemweb.com.au/Reports/Archive/ROOFTOP_PV/ACTUAL/',
                    '%PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_%.zip%')
        rooftop_weeks = to_download('rooftop_weeks_web', 'rooftop_weekly',
                                    "filename >= 'PUBLIC_ROOFTOP_PV_ACTUAL_MEASUREMENT_20260827'")
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

    # Each file on its own: it is downloaded when its log row is missing or 24 hours old, and
    # one that fails keeps its previous copy and its previous log row, so the next run tries
    # it again and the other files, and the facts, are not held up by it.
    def is_fresh(source_type):
        return session.sql(f"""
            SELECT count(*) > 0 FROM _csv_archive_log
            WHERE source_type = '{source_type}' AND archived_at > now() - INTERVAL 24 HOUR
        """).fetchone()[0]

    def log_duid(source_type, source_filename, url, csv_filename):
        session.execute("DELETE FROM _csv_archive_log WHERE source_type = ?", [source_type])
        session.execute(
            "INSERT INTO _csv_archive_log VALUES "
            "(?, ?, ?, CAST(? AS TIMESTAMPTZ), NULL, ?, NULL, ?)",
            [source_type, source_filename, f"/duid/{csv_filename}",
             datetime.now(timezone.utc).isoformat(), url, csv_filename.rsplit(".", 1)[0]],
        )

    duid_dir = f"{csv_archive_path}/duid"
    if not duid_dir.startswith(("az://", "abfss://")):
        os.makedirs(duid_dir, exist_ok=True)

    for source_type, source_filename, url, csv_filename in duid_sources:
        if is_fresh(source_type):
            continue
        try:
            # Through a local file: a download that breaks half way must not leave a
            # truncated file over the previous copy.
            with tempfile.TemporaryDirectory() as tmp:
                local = os.path.join(tmp, csv_filename).replace("\\", "/")
                session.sql(f"""
                    COPY (
                        SELECT * FROM read_csv_auto('{url}',
                            null_padding=true, ignore_errors=true
                            {", header=true" if source_filename == "WA_ENERGY" else ""})
                    ) TO '{local}' (FORMAT CSV, HEADER)
                """)
                copy_to_onelake(local, f"{duid_dir}/{csv_filename}")
            log_duid(source_type, source_filename, url, csv_filename)
        except Exception as e:
            warn(f"{csv_filename} unavailable, keeping the previous copy: {e}")

    # Three tables of AEMO's MMSDM registration data, from the newest monthly archive: they
    # hold every DUID and genset that ever ran, registered or not. dim_duid takes each
    # unit's CO2-e factor from GENUNITS through DUALLOC, dim_interconnector reads
    # INTERCONNECTOR. A month is archived in the weeks after it (2026-08 on 2026-09-25), so
    # the newest is last month's or one before; a month not out yet answers 404. Saved as
    # the file's D rows under its own I row: AEMO's column names, without the first four
    # (record type, report, table, version).
    mmsdm_reference = [
        ("duid_genunits", "GENUNITS", "genunits.csv"),
        ("duid_dualloc", "DUALLOC", "dualloc.csv"),
        ("duid_interconnector", "INTERCONNECTOR", "interconnector.csv"),
    ]
    for source_type, table, csv_filename in mmsdm_reference:
        if is_fresh(source_type):
            continue
        try:
            now = datetime.now(timezone.utc)
            with tempfile.TemporaryDirectory() as tmp:
                for back in (1, 2, 3):
                    year, month = divmod(now.year * 12 + now.month - 1 - back, 12)
                    month += 1
                    url = mmsdm_url(table, year, month)
                    try:
                        (_, _, gz_path), = download_and_extract(url, tmp)
                        break
                    except urllib.error.HTTPError as e:
                        if e.code != 404 or back == 3:
                            raise
                read = (f"read_csv('{gz_path.replace(chr(92), '/')}', skip = 1, header = true, "
                        "all_varchar = true, null_padding = true, strict_mode = false)")
                cols = [row[0] for row in session.sql(f"DESCRIBE SELECT * FROM {read}").fetchall()]
                local = os.path.join(tmp, csv_filename).replace("\\", "/")
                session.sql(f"""
                    COPY (
                        SELECT {", ".join(f'"{c}"' for c in cols[4:])} FROM {read}
                        WHERE "{cols[0]}" = 'D'
                    ) TO '{local}' (FORMAT CSV, HEADER)
                """)
                copy_to_onelake(local, f"{duid_dir}/{csv_filename}")
            log_duid(source_type, f"{table}_{year}{month:02d}", url, csv_filename)
            print(f"  MMSDM {table}: {year}-{month:02d}")
        except Exception as e:
            warn(f"{csv_filename} unavailable, keeping the previous copy: {e}")

    # AEMO's NEM Registration and Exemption List, as archived weekly by
    # djouallah/aemo_data (data/duid/registration/<name>_<YYYYMMDD>.xls, really an
    # .xlsx): the newest one's generator sheet is saved as registration.csv, which
    # dim_duid reads. When this fails the previous registration.csv stays in place.
    if not is_fresh("duid_registration"):
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
                    ) TO ('{duid_dir}/registration.csv') (FORMAT CSV, HEADER)
                """)
            log_duid("duid_registration", latest["name"].rsplit(".", 1)[0],
                     latest["download_url"], "registration.csv")
            print(f"  DUID registration list: {latest['name']}")
        except Exception as e:
            warn(f"AEMO registration list unavailable, keeping the previous registration.csv: {e}")

    # =========================================================================
    # Save log to parquet and return
    # =========================================================================
    # Only when this run changed it: process_downloads saves after each batch already, and
    # a run that fetched nothing has nothing to write over the durable log.
    if session.sql("SELECT count(*), max(archived_at) FROM _csv_archive_log").fetchone() != log_state:
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
