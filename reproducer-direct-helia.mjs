/**
 * Sibling to reproducer.mjs — same shape, but no kubo in the middle. Two helia
 * instances dial each other directly and exchange pubsub messages over their direct
 * gossipsub mesh. If this run reports clean delivery while reproducer.mjs (which puts
 * a kubo daemon between them) reports heavy loss, the bug is on the helia↔kubo
 * interop side, not in @libp2p/gossipsub itself.
 *
 * Run:
 *   npm install
 *   node reproducer-direct-helia.mjs
 */

import { createHelia } from "helia";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { webSockets } from "@libp2p/websockets";
import { multiaddr } from "@multiformats/multiaddr";
import { MemoryBlockstore } from "blockstore-core";
import { bitswap } from "@helia/block-brokers";
import { encode as cborEncode, decode as cborDecode } from "cborg";

const TOPIC = "pkcjs-bug-repro-direct-" + Date.now();
const NUM_MESSAGES = 30;

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

async function makeHelia(label, listenPort) {
    const listen = listenPort ? [`/ip4/127.0.0.1/tcp/${listenPort}/ws`] : [];
    const helia = await createHelia({
        libp2p: {
            addresses: { listen },
            transports: [webSockets()],
            connectionGater: { denyDialMultiaddr: async () => false },
            services: { identify: identify(), pubsub: gossipsub() }
        },
        blockstore: new MemoryBlockstore(),
        blockBrokers: [bitswap()],
        start: false
    });
    await helia.start();
    const addrs = helia.libp2p.getMultiaddrs().map(String);
    log(`helia ${label} started, peer id =`, helia.libp2p.peerId.toString(), "addrs=", addrs);
    return { helia, addrs };
}

async function main() {
    const { helia: heliaA } = await makeHelia("A (publisher)");
    const { helia: heliaB, addrs: heliaBAddrs } = await makeHelia("B (observer)", 26001);

    let observerReceived = [];
    heliaB.libp2p.services.pubsub.addEventListener("message", (evt) => {
        if (evt.detail.topic !== TOPIC) return;
        try {
            const dec = cborDecode(evt.detail.data);
            observerReceived.push({ ts: Date.now(), seq: dec.seq, size: evt.detail.data.length });
            log(`[heliaB] received seq=${dec.seq} bytes=${evt.detail.data.length}`);
        } catch {
            observerReceived.push({ ts: Date.now(), size: evt.detail.data.length });
            log(`[heliaB] received non-cbor bytes=${evt.detail.data.length}`);
        }
    });

    const dialAddr = heliaBAddrs[0];
    if (!dialAddr) throw new Error("heliaB has no dialable addresses");
    log("heliaA dialing heliaB at", dialAddr);
    await heliaA.libp2p.dial(multiaddr(dialAddr));

    log("Subscribing both to topic", TOPIC);
    heliaA.libp2p.services.pubsub.subscribe(TOPIC);
    heliaB.libp2p.services.pubsub.subscribe(TOPIC);

    log("Waiting for gossipsub mesh to stabilize (5s)...");
    await new Promise((r) => setTimeout(r, 5000));
    log("heliaA mesh peers:", heliaA.libp2p.services.pubsub.getMeshPeers(TOPIC).map(String));
    log("heliaB mesh peers:", heliaB.libp2p.services.pubsub.getMeshPeers(TOPIC).map(String));

    const publishedSeqs = [];
    for (let i = 0; i < NUM_MESSAGES; i++) {
        const payload = Buffer.alloc(200 + (i % 500));
        payload[0] = i & 0xff;
        const data = cborEncode({ seq: i, payload, ts: Date.now() });
        const res = await heliaA.libp2p.services.pubsub.publish(TOPIC, data);
        publishedSeqs.push({ seq: i, recipients: res.recipients.map(String), size: data.length });
        log(`[heliaA publish] seq=${i} bytes=${data.length} recipients=${res.recipients.length}`);
        await new Promise((r) => setTimeout(r, 250));
    }

    log("Waiting 5s for any in-flight messages...");
    await new Promise((r) => setTimeout(r, 5000));

    const publishedSet = new Set(publishedSeqs.map((p) => p.seq));
    const observerSet = new Set(observerReceived.map((m) => m.seq).filter((s) => s !== undefined));
    const observerMissing = [...publishedSet].filter((s) => !observerSet.has(s));

    console.log("\n" + "=".repeat(60));
    console.log("DIRECT helia↔helia REPRODUCER RESULTS (no kubo)");
    console.log("=".repeat(60));
    console.log(`Published from heliaA: ${publishedSet.size}`);
    console.log(`heliaB received: ${observerSet.size} of ${publishedSet.size}`);
    if (observerMissing.length) console.log(`heliaB MISSING seqs: ${JSON.stringify(observerMissing)}`);
    if (!observerMissing.length) console.log("✓ All messages received — direct helia↔helia is clean.");
    else console.log("✗ helia↔helia loses messages too — bug is in @libp2p/gossipsub, not kubo.");
    console.log("=".repeat(60));

    await heliaA.stop();
    await heliaB.stop();
}

main().catch((e) => {
    console.error("Reproducer fatal error:", e);
    process.exit(1);
});
