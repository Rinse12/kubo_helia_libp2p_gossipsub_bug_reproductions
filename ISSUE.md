# ~80% pubsub message loss between helia 6.1.4 (`@libp2p/gossipsub` 15.0.20) and kubo 0.41.0

## Severity

This breaks bidirectional pubsub-driven protocols (request/response, challenge/answer/verification) between any helia node on `@libp2p/gossipsub` 15.0.20 and any kubo 0.41.0 node. The publisher's API reports success on every publish, so applications can't tell anything is wrong.

## Summary

When a helia 6.1.4 node and a kubo 0.41.0 daemon are gossipsub mesh peers and the helia node publishes a sequence of messages to a topic both have subscribed to:

- A separate helia 6.1.4 node, also gossipsub-meshed through the same kubo, receives only **~10–20 %** of those messages.
- A subscriber listening on kubo's local `/pubsub/sub` HTTP-RPC stream receives the **same ~10–20 %** — never a different set, never a superset.

When the same two helia nodes dial each other directly (no kubo in the path), **30/30 messages are delivered cleanly**. So the loss is specific to the helia ↔ kubo gossipsub interop.

The publisher sees nothing wrong: every `pubsub.publish()` returns with `recipients = [<kubo peer id>]`, the libp2p connection to kubo stays `open`, the gossipsub mesh stays stable for the topic, and `OutboundStream`'s `errCallback` never fires.

## Reproducer

Self-contained reproducer (~570 LOC across two scripts + a `package.json` pinning exact versions):

https://github.com/Rinse12/kubo_helia_libp2p_gossipsub_bug_reproductions

```
git clone https://github.com/Rinse12/kubo_helia_libp2p_gossipsub_bug_reproductions
cd kubo_helia_libp2p_gossipsub_bug_reproductions
npm install
npm run repro:via-kubo   # the failing case
npm run repro:direct     # the control: no kubo, 30/30 clean
```

`reproducer.mjs` spawns a fresh kubo daemon on dedicated ports, two helia instances, has both helias and a kubo HTTP `/pubsub/sub` subscribe to the same topic, then publishes 30 small CBOR messages from heliaA at 250 ms cadence.

`reproducer-direct-helia.mjs` does the same publisher/observer flow but the two helias dial each other directly with no kubo in the middle.

## Versions

```json
{
  "@helia/block-brokers": "5.2.4",
  "@libp2p/gossipsub": "15.0.20",
  "@libp2p/identify": "4.1.3",
  "@libp2p/websockets": "10.1.11",
  "@multiformats/multiaddr": "13.0.1",
  "blockstore-core": "6.1.2",
  "cborg": "4.5.8",
  "helia": "6.1.4",
  "kubo": "0.41.0"
}
```

Node.js 22 on Linux (Ubuntu 24 in CI, Linux 6.8 locally).

## Observed output (via-kubo reproducer)

Run 1:
```
Published from heliaA: 30 messages
heliaB (gossipsub mesh observer) received: 4 of 30
kubo HTTP /pubsub/sub subscriber received: 4 of 30
heliaB MISSING seqs: [1,2,4,6,7,8,9,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29]
kubo HTTP MISSING seqs: [1,2,4,6,7,8,9,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29]
```

Run 2 (different machine, fresh node_modules):
```
Published from heliaA: 30 messages
heliaB received: 2 of 30
kubo HTTP received: 2 of 30
```

Across four consecutive runs we observed 2, 3, 4, and 8 of 30 messages delivered. Loss is consistently 70–93 %; the *same* set of messages reaches both subscribers each run.

## Observed output (direct-helia reproducer, control)

```
Published from heliaA: 30
heliaB received: 30 of 30
✓ All messages received — direct helia↔helia is clean.
```

## What the publisher sees on every dropped message

For every dropped message:

1. `pubsub.publish(topic, data)` resolves with `recipients = [<kubo peer id>]`.
2. `helia.libp2p.getConnections(<kubo peer>)` returns one connection in `status: 'open'`.
3. `pubsub.getMeshPeers(topic)` includes the kubo peer.
4. No `gossipsub:prune` event fires for that peer + topic.
5. The publisher never observes any `peer:disconnect` or `connection:close`.
6. The `OutboundStream` error callback (constructed at [`@libp2p/gossipsub/src/gossipsub.js:485`](https://github.com/ChainSafe/js-libp2p-gossipsub/blob/v15.0.20/src/gossipsub.ts) — fires on `rawStream.close` events with `evt.error`) does **not** fire.



## What we cannot determine from the JS side

Whether the bytes leave the helia process at all. The publisher's gossipsub state, libp2p connection state, and OutboundStream error path all report success. Determining which side is dropping requires either:

- `tcpdump -i lo -nn -X port 25002` (kubo's swarm port in the reproducer) during the run, to see if the bytes hit the wire;
- or kubo's gossipsub debug logs. **Note:** kubo 0.41 does not register `pubsub` or `gossipsub` as named loggers — `ipfs log ls` only exposes `pubsub-valuestore` (for IPNS over pubsub). `GOLOG_LOG_LEVEL=*=debug` does not surface gossipsub protocol traces. Re-enabling those loggers in kubo would also help.

## Notes on configuration

- gossipsub is constructed with default options on both sides (`gossipsub()` on helia, kubo's defaults).
- Topic name has no special characters; reproducer regenerates a fresh topic on every run.
- Message payloads are 200–700 bytes, well below any mesh maxMessageSize.
- StrictSign / StrictNoSign default in `@libp2p/gossipsub` 15.0.20: configured by default to whatever the package ships.
- No custom topic validators on either side.
- Both reproducers pin `addresses.listen` and use websockets transport on loopback.

