# helia ↔ kubo gossipsub message loss

Reproducer for ~80% pubsub message loss between a helia 6.1.4 publisher (using `@libp2p/gossipsub` 15.0.20) and a kubo 0.41.0 daemon. See [ISSUE.md](./ISSUE.md) for the full write-up to file upstream.

## Run

```
npm install
npm run repro:via-kubo   # the failing case — spawns its own kubo, ~80% loss
npm run repro:direct     # control with no kubo — 30/30 clean
```

`repro` runs both sequentially.

## Files

- [`reproducer.mjs`](./reproducer.mjs) — failing case: helia → kubo → helia (and kubo HTTP RPC subscriber). Spawns its own kubo daemon on ports 25001/25002 in a temp repo; cleans up on exit.
- [`reproducer-direct-helia.mjs`](./reproducer-direct-helia.mjs) — control case: same publisher/observer wiring, no kubo in the middle.
- [`package.json`](./package.json) — exact pinned versions (matching the failing pkc-js setup).
- [`ISSUE.md`](./ISSUE.md) — copy-paste-ready GitHub issue body.

## Versions

`helia 6.1.4`, `@libp2p/gossipsub 15.0.20`, `kubo 0.41.0`. Full list in [package.json](./package.json).
