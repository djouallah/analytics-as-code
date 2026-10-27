module github.com/djouallah/analytics-as-code/maintain

go 1.26.3

// apache/iceberg-go main, pinned to a commit (c7fe5a97, 2026-10-27): the Azure blob listing the
// orphan pass needs is after the v0.7.0 release. Move the pin by hand; back to a release tag
// once one carries it.
require github.com/apache/iceberg-go v0.7.1-0.20261027065834-c7fe5a9747e4
