// Table maintenance for the OneLake Iceberg catalog, on apache/iceberg-go: `maintain <record.json>`.
//
// process_data commits to the catalog every hour, and nothing on that write path folds the small
// files back together or drops a snapshot. This is the daily job that does, one table at a time
// (table_maintenance.yml, in the `process-data` concurrency group so it never overlaps a dbt run:
// a rewrite commits optimistically, and overlapping a merge would fail one side):
//
//  1. compact: bin-pack the data files to TARGET_MB, a group of at least MIN_INPUT_FILES files;
//     the position deletes of the files it rewrites go with them;
//  2. dangling deletes: position delete files whose data file is no longer in the snapshot
//     (rewritten by an earlier compaction that left them behind) are removed. Every reader
//     otherwise opens them all: fct_curtailment_region had 534 delete files, 520 of them
//     pointing at nothing (2026-10-27);
//  3. expire: snapshots older than EXPIRE_OLDER_THAN_DAYS (the current one always kept), and the
//     files only they referenced are deleted with them;
//  4. orphans: files no snapshot or metadata references, older than ORPHAN_OLDER_THAN_DAYS. A
//     path with a `_` or `.` segment (OneLake's `_delta_log/`) is never deleted.
//
// One library for all four, independent of the engines that write the tables. It replaced
// DuckDB's iceberg_rewrite_data_files (which leaves delete files behind) plus a pyiceberg fork.
// Ported from djouallah/lakehouse_benchmark's .github/scripts/maintain.
//
// The record (per table: before/after counts and each step's result or its exact error) is
// rewritten after every table, so a job killed by its timeout still leaves what it did. Never
// fails on a table; exits 1 only when every attempted table errored.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"runtime/debug"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	"github.com/apache/iceberg-go"
	"github.com/apache/iceberg-go/catalog"
	"github.com/apache/iceberg-go/catalog/rest"
	_ "github.com/apache/iceberg-go/io/gocloud/azure"
	"github.com/apache/iceberg-go/table"
	"github.com/apache/iceberg-go/table/compaction"
	"github.com/apache/iceberg-go/table/maintenance"
)

const (
	catalogURI   = "https://onelake.table.fabric.microsoft.com/iceberg"
	blobEndpoint = "blob.fabric.microsoft.com"
	storageScope = "https://storage.azure.com/.default"
	oidcAudience = "api://AzureADTokenExchange"
	// The reserved field id of a position delete file's file_path column: its lower and upper
	// bounds name the data file it targets when they are equal.
	filePathFieldID = 2147483546
	// The catalog and the blobs hold the bearer as a string: reconnect when less than this remains.
	refreshBefore = 10 * time.Minute
)

// The namespaces the pipeline writes; dbt's own scratch relations are left alone.
var (
	namespaceRe = regexp.MustCompile(`^(landing|mart)$`)
	scratch     = []string{"__stage", "__dbt_tmp"}
)

func envInt(key string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(key)); err == nil {
		return v
	}
	return def
}

func envFloat(key string, def float64) float64 {
	if v, err := strconv.ParseFloat(os.Getenv(key), 64); err == nil {
		return v
	}
	return def
}

var (
	targetMB      = envInt("COMPACT_TARGET_MB", 128)
	minInputFiles = envInt("COMPACT_MIN_INPUT_FILES", 5)
	// Stop starting new tables past this much wall clock, so the job reports what it did instead
	// of being killed mid-rewrite. Whatever is skipped is tomorrow's: compaction is incremental.
	budgetMinutes = envFloat("COMPACT_BUDGET_MINUTES", 70)
	expireDays    = envFloat("EXPIRE_OLDER_THAN_DAYS", 1)
	// A file younger than this may belong to a commit in flight, so it is never a candidate.
	orphanDays = envFloat("ORPHAN_OLDER_THAN_DAYS", 3)
)

func days(d float64) time.Duration { return time.Duration(d * 24 * float64(time.Hour)) }

// --- record --------------------------------------------------------------------------------------

type tableState struct {
	Snapshots   int    `json:"snapshots"`
	DataFiles   int    `json:"data_files"`
	DeleteFiles int    `json:"delete_files"`
	Bytes       *int64 `json:"bytes"`
	Rows        *int64 `json:"rows"`
}

type compactResult struct {
	Rewritten      int   `json:"rewritten"`
	Added          int   `json:"added"`
	RemovedDeletes int   `json:"removed_deletes"`
	RewrittenBytes int64 `json:"rewritten_bytes"`
}

type orphanResult struct {
	Deleted int   `json:"deleted"`
	Kept    int   `json:"kept_hidden"`
	Failed  int   `json:"failed"`
	Bytes   int64 `json:"bytes"`
}

type entry struct {
	Table    string            `json:"table"`
	Skipped  string            `json:"skipped,omitempty"`
	Before   *tableState       `json:"before,omitempty"`
	Compact  *compactResult    `json:"compact,omitempty"`
	Dangling *int              `json:"dangling_deletes_removed,omitempty"`
	Expired  *int              `json:"expired,omitempty"`
	Orphans  *orphanResult     `json:"orphans,omitempty"`
	After    *tableState       `json:"after,omitempty"`
	Error    map[string]string `json:"error,omitempty"`
	Seconds  float64           `json:"seconds,omitempty"`
}

type record struct {
	RunID    string            `json:"run_id"`
	Started  string            `json:"started"`
	Finished string            `json:"finished"`
	Settings map[string]any    `json:"settings"`
	Versions map[string]string `json:"versions"`
	Tables   []*entry          `json:"tables"`
}

func (r *record) save(path string) {
	b, _ := json.MarshalIndent(r, "", "  ")
	if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
		fmt.Printf("::warning::could not write %s: %v\n", path, err)
	}
}

func oneline(err error) string {
	s := strings.Join(strings.Fields(err.Error()), " ")
	if len(s) > 600 {
		s = s[:600] + "..."
	}
	return s
}

func icebergGoVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		for _, d := range info.Deps {
			if d.Path == "github.com/apache/iceberg-go" {
				return d.Version
			}
		}
	}
	return ""
}

// --- credentials and catalog ---------------------------------------------------------------------

// In Actions, a client assertion minted fresh from the GitHub OIDC endpoint on every token
// (`az login --federated-token` cannot refresh past its first token); on a laptop, `az login`.
func credential() (azcore.TokenCredential, error) {
	reqURL := os.Getenv("ACTIONS_ID_TOKEN_REQUEST_URL")
	if reqURL == "" {
		return azidentity.NewAzureCLICredential(nil)
	}
	assertion := func(ctx context.Context) (string, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL+"&audience="+oidcAudience, nil)
		if err != nil {
			return "", err
		}
		req.Header.Set("Authorization", "Bearer "+os.Getenv("ACTIONS_ID_TOKEN_REQUEST_TOKEN"))
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return "", err
		}
		defer resp.Body.Close()
		var body struct{ Value string }
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			return "", err
		}
		return body.Value, nil
	}
	return azidentity.NewClientAssertionCredential(
		os.Getenv("AZURE_TENANT_ID"), os.Getenv("AZURE_CLIENT_ID"), assertion, nil)
}

type conn struct {
	cred    azcore.TokenCredential
	cat     *rest.Catalog
	expires time.Time
}

// fresh returns the catalog, reconnected on a new bearer when the current one runs low. The same
// bearer serves the catalog and, as adls.token, the table's blobs (OneLake's catalog vends none).
func (c *conn) fresh(ctx context.Context) (*rest.Catalog, error) {
	if c.cat != nil && time.Until(c.expires) > refreshBefore {
		return c.cat, nil
	}
	tok, err := c.cred.GetToken(ctx, policy.TokenRequestOptions{Scopes: []string{storageScope}})
	if err != nil {
		return nil, fmt.Errorf("token: %w", err)
	}
	warehouse := os.Getenv("WS_ID") + "/" + os.Getenv("LH_ID")
	cat, err := rest.NewCatalog(ctx, "onelake", catalogURI,
		rest.WithOAuthToken(tok.Token),
		rest.WithWarehouseLocation(warehouse),
		rest.WithAdditionalProps(iceberg.Properties{"adls.token": tok.Token, "adls.endpoint": blobEndpoint}))
	if err != nil {
		return nil, fmt.Errorf("catalog: %w", err)
	}
	c.cat, c.expires = cat, tok.ExpiresOn
	return cat, nil
}

// --- measures and steps --------------------------------------------------------------------------

// What the current snapshot holds, from its manifests (not the snapshot summary: a writer may
// not keep totals there). Delete files are counted as the manifests list them, live or dangling.
func state(ctx context.Context, tbl *table.Table) (*tableState, error) {
	s := &tableState{Snapshots: len(tbl.Metadata().Snapshots())}
	var bytes, rows int64
	s.Bytes, s.Rows = &bytes, &rows
	snap := tbl.CurrentSnapshot()
	if snap == nil {
		return s, nil
	}
	fs, err := tbl.FS(ctx)
	if err != nil {
		return nil, err
	}
	manifests, err := snap.Manifests(fs)
	if err != nil {
		return nil, err
	}
	for _, m := range manifests {
		for e, err := range m.Entries(fs, true) {
			if err != nil {
				return nil, err
			}
			df := e.DataFile()
			if m.ManifestContent() == iceberg.ManifestContentData {
				s.DataFiles++
				bytes += df.FileSizeBytes()
				rows += df.Count()
			} else {
				s.DeleteFiles++
			}
		}
	}
	return s, nil
}

func compact(ctx context.Context, tbl *table.Table) (*compactResult, error) {
	cfg := compaction.DefaultConfig()
	cfg.TargetFileSizeBytes = int64(targetMB) << 20
	cfg.MinFileSizeBytes = cfg.TargetFileSizeBytes * 3 / 4
	cfg.MaxFileSizeBytes = cfg.TargetFileSizeBytes * 9 / 5
	cfg.MinInputFiles = uint(minInputFiles)
	plan, err := compaction.Analyze(ctx, tbl, cfg)
	if err != nil {
		return nil, fmt.Errorf("plan: %w", err)
	}
	if len(plan.Groups) == 0 {
		return &compactResult{}, nil
	}
	groups := make([]table.CompactionTaskGroup, len(plan.Groups))
	for i, g := range plan.Groups {
		groups[i] = table.CompactionTaskGroup{PartitionKey: g.PartitionKey, Tasks: g.Tasks, TotalSizeBytes: g.TotalSizeBytes}
	}
	// The default read pipeline (GOMAXPROCS workers, each holding a whole task, 64 buffered
	// batches) took all 16 GB of a runner in seconds on a fct_scada in lakehouse_benchmark.
	// Bounded, a 128 MiB group peaks at about 3.7 GB.
	tx := tbl.NewTransaction()
	res, err := tx.RewriteDataFiles(ctx, groups, table.RewriteDataFilesOptions{GroupOptions: []table.CompactionGroupOption{
		table.WithCompactionTargetFileSize(int64(targetMB) << 20),
		table.WithCompactionScanConcurrency(2),
		table.WithCompactionArrowBatchSize(65536),
		table.WithCompactionRecordBatchBufferSize(4),
	}})
	if err != nil {
		return nil, err
	}
	if _, err := tx.Commit(ctx); err != nil {
		return nil, fmt.Errorf("commit: %w", err)
	}
	return &compactResult{Rewritten: res.RemovedDataFiles, Added: res.AddedDataFiles,
		RemovedDeletes: res.RemovedPositionDeleteFiles, RewrittenBytes: res.BytesBefore}, nil
}

// The one data file a position delete targets: its referenced_data_file, else equal file_path
// bounds. "" when it may target several (partition-scoped), which is never removed here.
func deleteTarget(df iceberg.DataFile) string {
	if ref := df.ReferencedDataFile(); ref != nil && *ref != "" {
		return *ref
	}
	lower, upper := df.LowerBoundValues()[filePathFieldID], df.UpperBoundValues()[filePathFieldID]
	if len(lower) == 0 || string(lower) != string(upper) {
		return ""
	}
	lit, err := iceberg.LiteralFromBytes(iceberg.PrimitiveTypes.String, lower)
	if err != nil {
		return ""
	}
	if v, ok := lit.(iceberg.TypedLiteral[string]); ok {
		return v.Value()
	}
	return ""
}

// Removes the position delete files whose one target data file is not in the current snapshot:
// they delete nothing, and every reader still opens them. One rewrite commit that adds nothing.
func dropDanglingDeletes(ctx context.Context, cat *rest.Catalog, ident table.Identifier) (int, error) {
	tbl, err := cat.LoadTable(ctx, ident)
	if err != nil {
		return 0, err
	}
	snap := tbl.CurrentSnapshot()
	if snap == nil {
		return 0, nil
	}
	fs, err := tbl.FS(ctx)
	if err != nil {
		return 0, err
	}
	manifests, err := snap.Manifests(fs)
	if err != nil {
		return 0, err
	}
	live := map[string]struct{}{}
	seen := map[string]struct{}{}
	var deletes []iceberg.DataFile
	for _, m := range manifests {
		for e, err := range m.Entries(fs, true) {
			if err != nil {
				return 0, err
			}
			df := e.DataFile()
			if m.ManifestContent() == iceberg.ManifestContentData {
				live[df.FilePath()] = struct{}{}
				continue
			}
			if df.ContentType() != iceberg.EntryContentPosDeletes || table.IsDeletionVector(df) {
				continue
			}
			if _, dup := seen[df.FilePath()]; !dup {
				seen[df.FilePath()] = struct{}{}
				deletes = append(deletes, df)
			}
		}
	}
	var dead []iceberg.DataFile
	for _, df := range deletes {
		if target := deleteTarget(df); target != "" {
			if _, ok := live[target]; !ok {
				dead = append(dead, df)
			}
		}
	}
	if len(dead) == 0 {
		return 0, nil
	}
	tx := tbl.NewTransaction()
	rw := tx.NewRewrite(nil)
	for _, df := range dead {
		rw.DeleteFile(df)
	}
	if err := rw.Commit(ctx); err != nil {
		return 0, err
	}
	if _, err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	return len(dead), nil
}

// Snapshots expired, counted by a re-read: a commit that returns is not proof it landed.
func expire(ctx context.Context, cat *rest.Catalog, ident table.Identifier) (int, error) {
	tbl, err := cat.LoadTable(ctx, ident)
	if err != nil {
		return 0, err
	}
	cutoff := time.Now().Add(-days(expireDays)).UnixMilli()
	victims := 0
	for _, s := range tbl.Metadata().Snapshots() {
		if s.TimestampMs < cutoff {
			victims++
		}
	}
	if victims == 0 {
		return 0, nil
	}
	before := len(tbl.Metadata().Snapshots())
	tx := tbl.NewTransaction()
	if err := tx.ExpireSnapshots(table.WithOlderThan(days(expireDays)), table.WithRetainLast(1)); err != nil {
		return 0, err
	}
	if _, err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	tbl, err = cat.LoadTable(ctx, ident)
	if err != nil {
		return 0, err
	}
	return before - len(tbl.Metadata().Snapshots()), nil
}

// A path under the table with a segment starting `_` or `.`: OneLake's `_delta_log/` (what
// Fabric shows Direct Lake), never Iceberg's, so never an orphan of it.
func hidden(path, root string) bool {
	rel := strings.TrimPrefix(path, strings.TrimSuffix(root, "/"))
	for _, seg := range strings.Split(rel, "/") {
		if strings.HasPrefix(seg, "_") || strings.HasPrefix(seg, ".") {
			return true
		}
	}
	return false
}

func removeOrphans(ctx context.Context, tbl *table.Table) (*orphanResult, error) {
	fs, err := tbl.FS(ctx)
	if err != nil {
		return nil, err
	}
	root, kept := tbl.Metadata().Location(), 0
	res, err := maintenance.DeleteOrphanFiles(ctx, tbl,
		maintenance.WithCleanupFilesOlderThan(days(orphanDays)),
		maintenance.WithCleanupDeleteFunc(func(ctx context.Context, path string) error {
			if hidden(path, root) {
				kept++
				return nil
			}
			return fs.Remove(ctx, path)
		}))
	out := &orphanResult{Deleted: len(res.DeletedFiles) - kept, Kept: kept,
		Failed: len(res.OrphanFiles) - len(res.DeletedFiles), Bytes: res.TotalSizeBytes}
	if out.Failed < 0 {
		out.Failed = 0
	}
	return out, err
}

// --- run -----------------------------------------------------------------------------------------

func tables(ctx context.Context, cat *rest.Catalog) ([]string, error) {
	namespaces, err := cat.ListNamespaces(ctx, nil)
	if err != nil {
		return nil, err
	}
	var out []string
	for _, ns := range namespaces {
		name := strings.Join(ns, ".")
		if !namespaceRe.MatchString(name) {
			continue
		}
		for ident, err := range cat.ListTables(ctx, ns) {
			if err != nil {
				return nil, err
			}
			if t := ident[len(ident)-1]; !isScratch(t) {
				out = append(out, name+"."+t)
			}
		}
	}
	sort.Strings(out)
	return out, nil
}

func isScratch(name string) bool {
	for _, s := range scratch {
		if strings.Contains(name, s) {
			return true
		}
	}
	return false
}

func run(path string) int {
	ctx := context.Background()
	cred, err := credential()
	if err != nil {
		fmt.Println("credential:", oneline(err))
		return 1
	}
	c := &conn{cred: cred}
	cat, err := c.fresh(ctx)
	if err != nil {
		fmt.Println(oneline(err))
		return 1
	}
	rec := &record{
		RunID:   envOr("GITHUB_RUN_ID", "local"),
		Started: time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		Settings: map[string]any{
			"target_mb": targetMB, "min_input_files": minInputFiles,
			"expire_days": expireDays, "orphan_days": orphanDays,
		},
		Versions: map[string]string{"iceberg-go": icebergGoVersion()},
		Tables:   []*entry{},
	}
	todo, err := tables(ctx, cat)
	if err != nil {
		fmt.Println("list tables:", oneline(err))
		return 1
	}
	fmt.Printf("%d table(s): compact to %d MiB (min %d input files), drop dangling deletes, expire "+
		"snapshots older than %gd, orphan files older than %gd; budget %g min; iceberg-go %s\n",
		len(todo), targetMB, minInputFiles, expireDays, orphanDays, budgetMinutes, rec.Versions["iceberg-go"])

	started := time.Now()
	for i, t := range todo {
		e := &entry{Table: t}
		rec.Tables = append(rec.Tables, e)
		if time.Since(started).Minutes() >= budgetMinutes {
			e.Skipped = fmt.Sprintf("not attempted (%g min budget spent)", budgetMinutes)
			continue
		}
		fmt.Printf("[%d/%d] %s ...\n", i+1, len(todo), t)
		t0 := time.Now()
		maintainTable(ctx, c, e)
		e.Seconds = float64(time.Since(t0).Milliseconds()) / 1000
		rec.save(path)
	}
	rec.Finished = time.Now().UTC().Format("2006-01-02T15:04:05Z")
	rec.save(path)

	attempted, failed := 0, 0
	for _, e := range rec.Tables {
		if e.Skipped == "" {
			attempted++
			if e.Error != nil {
				failed++
			}
		}
	}
	if attempted > 0 && failed == attempted {
		fmt.Println("::error::every table errored")
		return 1
	}
	return 0
}

func maintainTable(ctx context.Context, c *conn, e *entry) {
	fail := func(step string, err error) {
		if e.Error == nil {
			e.Error = map[string]string{}
		}
		e.Error[step] = oneline(err)
		fmt.Printf("  %s: %s\n", step, e.Error[step])
	}
	cat, err := c.fresh(ctx)
	if err != nil {
		fail("load", err)
		return
	}
	ident := catalog.ToIdentifier(e.Table)
	tbl, err := cat.LoadTable(ctx, ident)
	if err == nil {
		e.Before, err = state(ctx, tbl)
	}
	if err != nil {
		fail("load", err)
		return
	}
	fmt.Printf("  before: %d data files, %d delete files, %d snapshots\n", e.Before.DataFiles, e.Before.DeleteFiles, e.Before.Snapshots)

	if e.Compact, err = compact(ctx, tbl); err != nil {
		fail("compact", err)
	} else {
		fmt.Printf("  compact: %d -> %d files, %d delete files with them\n", e.Compact.Rewritten, e.Compact.Added, e.Compact.RemovedDeletes)
	}

	if n, err := dropDanglingDeletes(ctx, cat, ident); err != nil {
		fail("dangling", err)
	} else {
		e.Dangling = &n
		fmt.Printf("  dangling deletes removed: %d\n", n)
	}

	if n, err := expire(ctx, cat, ident); err != nil {
		fail("expired", err)
	} else {
		e.Expired = &n
		fmt.Printf("  expired: %d snapshots\n", n)
	}

	if tbl, err = cat.LoadTable(ctx, ident); err == nil {
		e.Orphans, err = removeOrphans(ctx, tbl)
	}
	if err != nil {
		fail("orphans", err)
	}
	if e.Orphans != nil {
		fmt.Printf("  orphans: %d deleted, %d kept (hidden paths), %d failed, %d bytes\n",
			e.Orphans.Deleted, e.Orphans.Kept, e.Orphans.Failed, e.Orphans.Bytes)
	}

	if tbl, err = cat.LoadTable(ctx, ident); err == nil {
		e.After, err = state(ctx, tbl)
	}
	if err != nil {
		fail("after", err)
	} else {
		fmt.Printf("  now: %d data files, %d delete files, %d snapshots\n", e.After.DataFiles, e.After.DeleteFiles, e.After.Snapshots)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: maintain <record.json>")
		os.Exit(2)
	}
	os.Exit(run(os.Args[1]))
}
