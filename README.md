# Brings CLI

`@vectojs/brings-cli` is the local-first command line interface for creating,
inspecting, and changing Brings schema-v1 design documents. It uses named
design intentions backed by `@vectojs/brings-core`; it has no generic command
JSON escape hatch, cloud account, synchronization, or collaboration service.

## Install

The executable runs with Bun:

```bash
bun add --global @vectojs/brings-cli
brings --help
```

## Document commands

```text
brings create <file> [--force] [--json]
brings inspect <file> [--json]
brings frame create <file> --x <n> --y <n> [options]
brings rectangle create <file> --x <n> --y <n> [options]
brings text create <file> --x <n> --y <n> --content <text> [options]
brings node set <file> --node <uuid> [property flags]
brings node transform <file> --node <uuid> [transform flags]
brings node delete <file> --node <uuid> [--node <uuid>...]
brings node group <file> --node <uuid> --node <uuid> [--id <uuid>]
brings node ungroup <file> --node <uuid>
brings layer move <file> --node <uuid> [--node <uuid>...] --parent <uuid|null> --index <n>
```

Every existing-document mutation requires
`--expected-revision <non-negative-safe-integer>` and accepts `--dry-run` and
`--json`. Inspect first, pass its revision to exactly one mutation, then inspect
again. A stale revision returns `document.revision-conflict` without changing
the file.

Creation coordinates are parent-local. Transform deltas and scale origins are
page-space. Colors accept only `#RRGGBB`, `#RRGGBBAA`, or `none`. Boolean values
must be the literal lowercase values `true` or `false`.

```bash
brings inspect ./design.brings.json --json
brings rectangle create ./design.brings.json \
  --x 40 --y 64 --width 160 --height 96 \
  --expected-revision 12 --dry-run --json
brings rectangle create ./design.brings.json \
  --x 40 --y 64 --width 160 --height 96 \
  --id 11111111-1111-4111-8111-111111111111 \
  --expected-revision 12 --json
```

When a dry run generates IDs, pass the returned `generatedNodeIds` explicitly
to the durable replay. Dry run does not reserve a revision or an ID.

## File safety

Mutations validate through Core, acquire `<file>.brings.lock`, verify a regular
single-link target through no-follow handles, compare the expected revision,
execute one Core command, write and sync a same-directory temporary file, then
atomically replace the target. New document creation publishes without
overwriting; `--force` is required for explicit replacement.

`document.locked` includes a recoverable sidecar-lock condition. Brings never
guesses that a lock is stale: inspect its metadata and remove it only after a
human confirms the recorded writer is gone. If lock release fails after a
commit, success contains `document.lock-release-failed` in `warnings`; the
document changed and the sidecar lock needs manual recovery.

Atomic replacement creates a new inode. Unix mode bits are preserved for
existing targets, but ownership follows the executing process and ACLs or
extended attributes are not preserved. External programs that ignore the
sidecar lock are outside the cooperative concurrency guarantee.

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

## License

MIT
