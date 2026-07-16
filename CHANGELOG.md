# Changelog

All notable changes to this project are documented here.

## Unreleased

### Minor Changes

- Add revision-protected named Frame, Rectangle, Text, property, transform,
  deletion, grouping, ungrouping, and layer-movement commands.
- Add dry-run replay, stable JSON envelopes, sidecar locking, file-kind checks,
  atomic create/replace transactions, and explicit post-commit warnings.
- Correct `create` so it rejects an existing path unless `--force` is supplied.
