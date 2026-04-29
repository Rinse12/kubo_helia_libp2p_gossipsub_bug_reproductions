/**
 * Standalone reproducer for ~70–90% pubsub message loss between
 *   helia 6.1.4 + @libp2p/gossipsub 15.0.20  ↔  kubo 0.41.0 (go-libp2p-pubsub).
 *
 * Symptoms: a helia publisher sends N pubsub messages on a topic that both (a) a kubo
 * daemon's local HTTP /pubsub/sub subscriber and (b) a second helia instance (gossipsub-
 * meshed through the same kubo) subscribe to. Most messages never reach either side.
 *
 * From the publisher's vantage point everything looks fine: `pubsub.publish()` returns
 * `recipients = [kubo peer]`, no OutboundStream error fires, the libp2p connection to
 * kubo stays `open`, the gossipsub mesh stays stable. But ~80% of messages silently
 * vanish.
 *
 * Both subscribers (gossipsub-mesh helia AND kubo HTTP /pubsub/sub) receive *exactly the
 * same* set of messages, which means the drop is on a single per-message decision *before*
 * kubo fans it out — either bytes never leave helia, or kubo drops at gossipsub validation
 * on receive. Once a message clears that gate, kubo correctly delivers to all subscribers.
 *
 * The sibling script reproducer-direct-helia.mjs runs the same publisher/observer flow
 * with no kubo in the middle and shows 30/30 clean delivery — so the issue is specific
 * to the helia ↔ kubo gossipsub interop, not to @libp2p/gossipsub on its own.
 *
 * Run:
 *   npm install
 *   node reproducer.mjs
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

import { createHelia } from "helia";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { multiaddr } from "@multiformats/multiaddr";
import { MemoryBlockstore } from "blockstore-core";
import { bitswap } from "@helia/block-brokers";
import { encode as cborEncode, decode as cborDecode } from "cborg";

import { path as kuboBinPath } from "kubo";

const execFileP = promisify(execFile);

// Configurable
const __dirname = path.dirname(new URL(import.meta.url).pathname);
const KUBO_REPO = path.join(__dirname, "kubo-repo");
const KUBO_API_PORT = 25001;
const KUBO_SWARM_PORT = 25002;
const TOPIC = "helia-kubo-bug-repro-topic-" + Date.now();
const NUM_MESSAGES = 30;

function log(...args) {
    console.log(`[${new Date().toISOString()}]`, ...args);
}

async function setupFreshKubo() {
    log("Cleaning kubo repo at", KUBO_REPO);
    if (existsSync(KUBO_REPO)) await rm(KUBO_REPO, { recursive: true, force: true });
    await mkdir(KUBO_REPO, { recursive: true });

    const env = { ...process.env, IPFS_PATH: KUBO_REPO };
    log("ipfs init...");
    await execFileP(kuboBinPath(), ["init"], { env });

    // Configure ports + bootstrap-rm to avoid reaching mainnet.
    const cfgRaw = await readFile(path.join(KUBO_REPO, "config"), "utf8");
    const cfg = JSON.parse(cfgRaw);
    cfg.Addresses.API = `/ip4/127.0.0.1/tcp/${KUBO_API_PORT}`;
    cfg.Addresses.Swarm = [`/ip4/127.0.0.1/tcp/${KUBO_SWARM_PORT}/ws`];
    cfg.Addresses.Gateway = "/ip4/127.0.0.1/tcp/0";
    cfg.Bootstrap = [];
    cfg.Discovery = cfg.Discovery || {};
    cfg.Discovery.MDNS = { Enabled: false };
    cfg.Pubsub = cfg.Pubsub || {};
    cfg.Pubsub.Enabled = true;
    cfg.Pubsub.Router = "gossipsub";
    await writeFile(path.join(KUBO_REPO, "config"), JSON.stringify(cfg, null, 2));

    log("Spawning kubo daemon...");
    const proc = spawn(kuboBinPath(), ["daemon", "--enable-pubsub-experiment"], {
        env,
        stdio: ["ignore", "pipe", "pipe"]
    });
    proc.stdout.on("data", (b) => process.stdout.write("[kubo] " + b));
    proc.stderr.on("data", (b) => process.stderr.write("[kubo] " + b));

    // Wait for API to be ready.
    for (let i = 0; i < 40; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${KUBO_API_PORT}/api/v0/id`, { method: "POST" });
            if (res.ok) {
                const id = await res.json();
                log("Kubo ready, peer id =", id.ID);
                return { proc, peerId: id.ID, swarmAddr: `/ip4/127.0.0.1/tcp/${KUBO_SWARM_PORT}/ws/p2p/${id.ID}` };
            }
        } catch {}
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("Kubo daemon failed to become ready");
}

// Subscribe to a topic via kubo's HTTP /pubsub/sub streaming endpoint. This mirrors
// what pkc-js LocalCommunity does — it's a long-lived chunked HTTP response where each
// chunk is a JSON-encoded message.
async function subscribeViaKuboHttp(topic, onMessage) {
    const topicArg = "u" + Buffer.from(topic, "utf8").toString("base64url").replace(/=+$/, "");
    const url = `http://127.0.0.1:${KUBO_API_PORT}/api/v0/pubsub/sub?arg=${topicArg}`;
    const ctrl = new AbortController();
    const res = await fetch(url, { method: "POST", signal: ctrl.signal });
    if (!res.ok) throw new Error("kubo /pubsub/sub failed: " + res.status);
    log("kubo HTTP subscriber active for topic", topic);
    (async () => {
        const reader = res.body.getReader();
        let buf = "";
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buf += new TextDecoder().decode(value);
                let nl;
                while ((nl = buf.indexOf("\n")) >= 0) {
                    const line = buf.slice(0, nl);
                    buf = buf.slice(nl + 1);
                    if (line.trim()) {
                        try {
                            const msg = JSON.parse(line);
                            // kubo 0.41 multibase-encodes msg.data — first char is the prefix.
                            // 'u' = base64url, 'm' = base64.
                            const raw = msg.data ?? "";
                            let data;
                            if (raw[0] === "u") data = Buffer.from(raw.slice(1), "base64url");
                            else if (raw[0] === "m") data = Buffer.from(raw.slice(1), "base64");
                            else data = Buffer.from(raw, "base64");
                            onMessage(data);
                        } catch (e) {
                            log("kubo http subscriber parse err:", e.message);
                        }
                    }
                }
            }
        } catch (e) {
            if (e.name !== "AbortError") log("kubo http subscriber loop err:", e.message);
        }
    })();
    return () => ctrl.abort();
}

async function makeHelia(label) {
    const helia = await createHelia({
        libp2p: {
            addresses: { listen: [] },
            services: { identify: identify(), pubsub: gossipsub() }
        },
        blockstore: new MemoryBlockstore(),
        blockBrokers: [bitswap()],
        start: false
    });
    await helia.start();
    log(`helia ${label} started, peer id =`, helia.libp2p.peerId.toString());
    return helia;
}

function describeMsg(data) {
    try {
        const dec = cborDecode(data);
        return `seq=${dec.seq ?? "?"} payload-bytes=${dec.payload?.length ?? "?"}`;
    } catch {
        return `non-cbor size=${data.length}`;
    }
}

async function main() {
    const { proc: kuboProc, peerId: kuboPeerId, swarmAddr: kuboSwarmAddr } = await setupFreshKubo();

    let kuboHttpReceived = [];
    const stopHttpSub = await subscribeViaKuboHttp(TOPIC, (data) => {
        const dec = (() => {
            try {
                return cborDecode(data);
            } catch {
                return null;
            }
        })();
        kuboHttpReceived.push({ ts: Date.now(), seq: dec?.seq, size: data.length });
        log("[kubo-http] received:", describeMsg(data));
    });

    const heliaA = await makeHelia("A (publisher)");
    const heliaB = await makeHelia("B (observer)");

    let observerReceived = [];
    heliaA.libp2p.services.pubsub.addEventListener("message", (evt) => {
        if (evt.detail.topic !== TOPIC) return;
        log("[heliaA self-message] (will be filtered, gossipsub doesn't deliver own messages)");
    });
    heliaB.libp2p.services.pubsub.addEventListener("message", (evt) => {
        if (evt.detail.topic !== TOPIC) return;
        const dec = (() => {
            try {
                return cborDecode(evt.detail.data);
            } catch {
                return null;
            }
        })();
        observerReceived.push({ ts: Date.now(), seq: dec?.seq, size: evt.detail.data.length });
        log("[heliaB observer] received:", describeMsg(evt.detail.data));
    });

    log("Dialing kubo from heliaA + heliaB at", kuboSwarmAddr);
    await heliaA.libp2p.dial(multiaddr(kuboSwarmAddr));
    await heliaB.libp2p.dial(multiaddr(kuboSwarmAddr));

    log("Subscribing both helias to topic", TOPIC);
    heliaA.libp2p.services.pubsub.subscribe(TOPIC);
    heliaB.libp2p.services.pubsub.subscribe(TOPIC);

    // Wait for gossipsub mesh to stabilize.
    log("Waiting for gossipsub mesh to stabilize (5s)...");
    await new Promise((r) => setTimeout(r, 5000));
    log("heliaA mesh peers for topic:", heliaA.libp2p.services.pubsub.getMeshPeers(TOPIC).map(String));
    log("heliaB mesh peers for topic:", heliaB.libp2p.services.pubsub.getMeshPeers(TOPIC).map(String));

    // Publish a sequence of messages.
    const publishedSeqs = [];
    for (let i = 0; i < NUM_MESSAGES; i++) {
        const payload = Buffer.alloc(200 + (i % 500));
        payload[0] = i & 0xff;
        const data = cborEncode({ seq: i, payload, ts: Date.now() });
        const res = await heliaA.libp2p.services.pubsub.publish(TOPIC, data);
        publishedSeqs.push({ seq: i, recipients: res.recipients.map(String), size: data.length, ts: Date.now() });
        log(`[heliaA publish] seq=${i} bytes=${data.length} recipients=${res.recipients.length}`);
        await new Promise((r) => setTimeout(r, 250)); // 250ms gap to mirror real publication cadence
    }

    log("Publishing complete, waiting 5s for any in-flight messages...");
    await new Promise((r) => setTimeout(r, 5000));

    // Report.
    const publishedSet = new Set(publishedSeqs.map((p) => p.seq));
    const observerSet = new Set(observerReceived.map((m) => m.seq).filter((s) => s !== undefined));
    const httpSet = new Set(kuboHttpReceived.map((m) => m.seq).filter((s) => s !== undefined));

    const observerMissing = [...publishedSet].filter((s) => !observerSet.has(s));
    const httpMissing = [...publishedSet].filter((s) => !httpSet.has(s));

    console.log("\n" + "=".repeat(60));
    console.log("REPRODUCER RESULTS");
    console.log("=".repeat(60));
    console.log(`Published from heliaA: ${publishedSet.size} messages`);
    console.log(`heliaB (gossipsub mesh observer) received: ${observerSet.size} of ${publishedSet.size}`);
    console.log(`kubo HTTP /pubsub/sub subscriber received: ${httpSet.size} of ${publishedSet.size}`);
    if (observerMissing.length) console.log(`heliaB MISSING seqs: ${JSON.stringify(observerMissing)}`);
    if (httpMissing.length) console.log(`kubo HTTP MISSING seqs: ${JSON.stringify(httpMissing)}`);
    if (!observerMissing.length && !httpMissing.length)
        console.log("✓ All messages received on both channels — no bug reproduced this run.");
    else console.log("✗ Bug reproduced: at least one channel is missing messages.");
    console.log("=".repeat(60));

    // Cleanup
    stopHttpSub();
    await heliaA.stop();
    await heliaB.stop();
    kuboProc.kill("SIGTERM");
    setTimeout(() => kuboProc.kill("SIGKILL"), 2000).unref();
}

main().catch((e) => {
    console.error("Reproducer fatal error:", e);
    process.exit(1);
});
