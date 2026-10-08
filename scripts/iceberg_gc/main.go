// Trial of iceberg-go's file-deleting maintenance on the OneLake catalog, dry run only.
//
// pyiceberg's expire_snapshots (scripts/expire_snapshots.py) is metadata-only: the data
// files of an expired snapshot stay in OneLake. iceberg-go (0.7.0) deletes them: its
// ExpireSnapshots removes the files only the expired snapshots referenced, and
// PlanOrphanFiles/ExecuteOrphanCleanup removes every file under the table's location that
// no snapshot references (which is what the snapshots OneLake already trimmed left behind).
//
// This prints, per table, what each would delete and commits nothing. In particular it
// groups the orphan candidates by folder: a folder that Fabric itself writes there (its
// Delta view of the table) would show up as "orphans" and must never be deleted.
//
// Usage: go run . <namespace.table>...   (env: ONELAKE_ENDPOINT, ONELAKE_TOKEN,
// WAREHOUSE_PATH; storage reads use the Azure CLI login of the job.)
package main

import (
	"context"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/apache/iceberg-go"
	"github.com/apache/iceberg-go/catalog"
	"github.com/apache/iceberg-go/catalog/rest"
	_ "github.com/apache/iceberg-go/io/gocloud"
	"github.com/apache/iceberg-go/table"
)

const (
	expireOlderThan = 24 * time.Hour // as scripts/expire_snapshots.py (EXPIRE_OLDER_THAN_DAYS=1)
	orphanOlderThan = 72 * time.Hour // iceberg-go's default: room for in-flight writes
)

func mib(n int64) string { return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20)) }

func dryRun(ctx context.Context, cat *rest.Catalog, name string) error {
	tbl, err := cat.LoadTable(ctx, catalog.ToIdentifier(strings.Split(name, ".")...))
	if err != nil {
		return fmt.Errorf("load: %w", err)
	}

	loc := tbl.Location()
	snaps := tbl.Metadata().Snapshots()
	oldest := time.Now()
	for _, s := range snaps {
		if t := time.UnixMilli(s.TimestampMs); t.Before(oldest) {
			oldest = t
		}
	}
	gc := tbl.Properties().Get("gc.enabled", "(unset: true)")
	fmt.Printf("  location   %s\n  snapshots  %d, oldest %s old, gc.enabled %s\n",
		loc, len(snaps), time.Since(oldest).Round(time.Minute), gc)

	tx := tbl.NewTransaction()
	if err := tx.ExpireSnapshots(table.WithOlderThan(expireOlderThan), table.WithPostCommit(false)); err != nil {
		fmt.Printf("  expire     ERROR %v\n", err)
	} else if staged, err := tx.StagedTable(); err != nil {
		fmt.Printf("  expire     ERROR %v\n", err)
	} else {
		fmt.Printf("  expire     would remove %d of %d snapshots (not committed)\n",
			len(snaps)-len(staged.Metadata().Snapshots()), len(snaps))
	}

	plan, err := tbl.PlanOrphanFiles(ctx, table.WithFilesOlderThan(orphanOlderThan))
	if err != nil {
		return fmt.Errorf("orphan scan: %w", err)
	}
	type group struct {
		n     int
		bytes int64
		eg    string
	}
	groups := map[string]*group{}
	for _, f := range plan.OrphanFiles() {
		rel := strings.TrimPrefix(strings.TrimPrefix(f.Path, loc), "/")
		dir := rel
		if i := strings.Index(rel, "/"); i >= 0 {
			dir = rel[:i] + "/"
		}
		g := groups[dir]
		if g == nil {
			g = &group{eg: rel}
			groups[dir] = g
		}
		g.n++
		g.bytes += f.SizeBytes
	}
	fmt.Printf("  orphans    %d files, %s, older than %s (not deleted)\n",
		len(plan.OrphanFiles()), mib(plan.TotalSizeBytes()), orphanOlderThan)
	dirs := make([]string, 0, len(groups))
	for d := range groups {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	for _, d := range dirs {
		g := groups[d]
		fmt.Printf("    %-14s %6d files %12s   e.g. %s\n", d, g.n, mib(g.bytes), g.eg)
	}
	return nil
}

func main() {
	ctx := context.Background()
	cat, err := rest.NewCatalog(ctx, "onelake", os.Getenv("ONELAKE_ENDPOINT"),
		rest.WithOAuthToken(os.Getenv("ONELAKE_TOKEN")),
		rest.WithWarehouseLocation(os.Getenv("WAREHOUSE_PATH")),
		// The table locations are abfss://<ws>@onelake.dfs.fabric.microsoft.com/...; the
		// account is "onelake" and the blob API is at this domain, as pyiceberg is told.
		rest.WithAdditionalProps(iceberg.Properties{"adls.endpoint": "blob.fabric.microsoft.com"}),
	)
	if err != nil {
		fmt.Fprintf(os.Stderr, "catalog: %v\n", err)
		os.Exit(1)
	}

	failed := 0
	for i, name := range os.Args[1:] {
		fmt.Printf("[%d/%d] %s\n", i+1, len(os.Args)-1, name)
		if err := dryRun(ctx, cat, name); err != nil {
			fmt.Printf("  ERROR %v\n", err)
			failed++
		}
		fmt.Println()
	}
	if failed > 0 {
		fmt.Printf("%d table(s) failed\n", failed)
		os.Exit(1)
	}
}
