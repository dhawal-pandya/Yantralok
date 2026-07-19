# Yantralok — Usage Guide

A hands-on guide for the person this tool is built for: a working software engineer trying to understand their own system. If you can read a service diagram but have never _watched_ one behave under load, this is for you.

This document is a hands-on walkthrough: how to use the product, start to finish.

---

## What it is (and what it isn't)

Yantralok is a **behavioral simulator** for distributed systems — think mechanical CAD plus stress simulation, but for architectures. You draw your system on a canvas, give each box realistic numbers, generate traffic, and watch where latency piles up, where the queue overflows, and how a failure cascades.

- It is **not** a deployment tool, a Kubernetes dashboard, or a diagram editor.
- Every box is a **behavioral model**, not a picture. Every line **carries requests**. The diagram _is_ the system.
- It runs **entirely in your browser**. No backend, no account, no data leaves your machine. Your systems are saved locally.

### The one idea to internalize

> **You own the inputs. The engine owns the consequences.**

You tell it a Postgres query takes 8 ms and the pool has 100 connections. It does _not_ second-guess those numbers — it computes what _emerges_ from them under load: the bottleneck, the latency accumulation on the critical path, the queue overflow, the retry cascade. Garbage in, garbage out — but the garbage is always visible and editable.

It predicts **emergent behavior**, governed by closed laws (Little's Law, resource conservation, retry/timeout amplification). It does **not** predict your base numbers — those are yours to measure or estimate. Don't know your Redis p99? Start from the sane default, then go ask your seniors the better question.

---

## Run it

Requirements: Node 18+.

```bash
npm install
npm run dev        # open the URL it prints (Vite dev server)
```

Other scripts: `npm test` (Vitest), `npm run build` (typecheck + production bundle), `npm run lint`, `npm run check` (lint + test).

---

## The 60-second tour

```
┌──────────────────────────────────────────────────────────────────┐
│ Toolbar:  name · systems ▾ · New · Delete · Examples ▾ · Import · Export ▾ │
├──────────────────────────────────────────────────────────────────┤
│ Run bar:  ▶ Simulate · ↺ Reset · ⑂ Compare · Stop · 1×2×4×8× ·      │
│           load ───○─── · ├──timeline scrubber──┤ · thru p99 fail bottleneck │
├───────────┬──────────────────────────────────────┬───────────────┤
│  Palette  │                                      │   Inspector    │
│ (components│              Canvas                  │ (selected node │
│  to place)│         (your system)                │  config + tools)│
│           │                                      ├───────────────┤
│           │                                      │  Requests      │
├───────────┴──────────────────────────────────────┴───────────────┤
│ Charts: live latency / throughput / utilization over time         │
└──────────────────────────────────────────────────────────────────┘
```

- **Palette** (left): every component, grouped by category. Drag one onto the canvas, or click to place it. Hover any item to read what it is, how it affects the sim, and the law it touches.
- **Canvas** (center): your system. Drag from a node's edge-handle to another node to connect them. Click a node or edge to select it.
- **Inspector** (right): the selected object's editable config — every input is first-class and always visible. Also holds the failure-injection buttons.
- **Run bar**: run / re-run, compare, stop, and live readouts (throughput, latency, failures, bottleneck, estimated cost).
- **Timeline bar** (under the charts): play/pause, rewind, the seek scrubber, the playback-speed and run-length selectors, and the **Glow** toggle with its ρ / lat / $ lens selector.
- **Charts** (bottom): streaming metrics — they move only because a simulated event happened, never for decoration. Hover a chart to read every series' value at that instant; hover its title for what the chart means.

**Everything is self-explaining and resizable.** Hover any control for a tooltip. Drag the dividers between panels (palette · canvas · inspector · charts) to resize them — your layout is remembered across reloads.

---

## Tutorial: your first system

We'll build `Client → API → Postgres`, run it, find the bottleneck, add a cache, then break it.

### 1. Build it by hand

1. In the **Palette**, add **Client**, then **API**, then **Postgres** — drag each onto the canvas, or click it to drop one in. Three nodes appear.
2. **Connect them:** hover a node until small dots (handles) appear on its sides. Drag from the **Client**'s right handle onto the **API**, then from **API** to **Postgres**. Two arrows appear; the label shows the link latency (1 ms default).
3. That's a runnable system already — every node shipped with sane defaults.

### 2. Run it

Press **▶ Simulate** (or hit **Space**). Traffic starts flowing:

- Packets animate along the links (each one is a _real_ simulated request).
- Each node shows live **utilization ρ** (a bar + a %) and its queue depth.
- The run bar readouts update: **throughput**, **latency**, **failures**, and the current **bottleneck**.

The **Client** drives 200 requests/second by default (its `Request rate`). The **API** has 200 threads at 20 ms each; **Postgres** has a 100-connection pool at 8 ms/query. At 200 req/s nothing is stressed yet.

### 3. Find the bottleneck

Select the **Client** and raise its **Request rate** (say from 200 to 4,000 req/s), then Re-run. Watch which tier turns amber, then red: the **bottleneck** readout names it. As that tier's `ρ → 1`, its queue grows and **latency diverges**: Little's Law biting, not an animation.

Here's the instructive part. The defaults are generous, so make a tier tight and watch the bottleneck _move_:

- Select **Postgres**, drop its **Connection pool** to ~20 (or raise **Query time** to ~15 ms). Raise the request rate again: now Postgres saturates first and is named the bottleneck.
- Loosen it again and the bottleneck jumps elsewhere (often the API's thread pool, since a thread is held for the _whole_ downstream call, not just its own work).

That's the lesson: **the bottleneck is a property of your numbers, not a fixed label.** The core loop is _turn up load → see what saturates first → change a knob → watch it move._ No guessing.

**Scaling out.** To raise a tier's ceiling, either bump its **Replicas** or put a **Load Balancer** in front of several copies of a service — it routes each request to one healthy backend (round-robin / least-connections / random). Kill one backend and its share shifts to the survivors, not a fractional outage. Relieve one bottleneck and the next one downstream reveals itself. Replicas mean what they mean in production: on an **API/Worker** they are identical instances ((1+N)× capacity, or turn on **Autoscaling** to let a control loop size the fleet); on **Postgres** they are _read_ replicas — reads route to the replica pool, writes stay on the primary (write capacity does **not** grow), and a read landing within the **Replication lag** of a write returns stale data, shown live as the node's `stale %`.

### 4. Add a cache

1. Place a **Redis** node. Connect **API → Redis** _and_ keep **API → Postgres**.
2. Select **Redis**. Its `Hit ratio` defaults to **0.9** — 90% of reads are served from cache and short-circuit; the 10% that miss fall through to Postgres.
3. Run again. Postgres load drops to roughly **(1 − hit ratio) × read rate**. The cache node shows its **measured hit rate** live. Lower the hit ratio and watch Postgres load climb — `DB load ≈ (1 − h) · λ`, exactly.

> Reads vs writes: select the **Client** and set a **Write ratio**. Writes bypass the cache and go straight to the store; reads consult the cache first.

### 5. Break it (failure injection)

1. Select **Redis**. In the Inspector's **Failure injection** row, press **Kill**.
2. The engine re-runs with a kill scheduled at the current time. Redis goes **DOWN**; with the cache gone, **100%** of reads now hit Postgres.
3. Watch the cascade: Postgres saturates, its queue overflows, the API's calls start timing out, retries multiply the load, and requests begin to **fail**. Nothing here is scripted — it _emerges_ from the numbers you set.

You can also **Restart** a node or add **Delay +300 ms**. Failures are part of the saved, reproducible run.

### 6. Compare timelines

First **inject a failure** (select a node → Inject: Kill / Restart / Delay) — Compare is disabled until you have one, because it has nothing to compare against otherwise. Then press **⑂ Compare**: the engine runs two branches from the same seed — _with_ your failures and _without_ them — and overlays the clean baseline as a grey line in the charts. The gap between the amber (this run) and grey (baseline) line is exactly what the failure cost. This is the "what would have happened" button. The button shows **⑂ Comparing** while active; click it again to turn the overlay off.

Use the **timeline scrubber** to rewind and replay any moment. Playback speed is 1×/2×/4×/8×. **Reset** returns to t=0; **Stop** clears the run.

---

## Reading the instruments

| Readout | Where | Meaning |
| --- | --- | --- |
| **ρ (utilization)** | on each node | Busy fraction of that tier's servers (0–100%). Near 100% = saturated; latency blows up. Color: green → amber → red. |
| **queue** | on each node | Mean requests waiting for a free server/thread/connection. |
| **hit** | on cache nodes | Measured cache hit rate this instant. |
| **N/s** | on non-cache nodes | Calls per second this tier is receiving (its share of load). |
| **throughput** | run bar | Completed requests/second. |
| **latency** | run bar | Mean end-to-end request latency (ms) in the current window. |
| **failures** | run bar | Failed requests/second (timeouts exhausted, queue overflow, dead dependency). |
| **bottleneck** | run bar | The tier with the highest utilization right now. |
| **cost** | run bar | Estimated infrastructure cost per month: usage measured over the run, priced at representative AWS on-demand rates, extrapolated as steady state. Capacity knobs size the billed fleet (a concurrency-400 API bills two boxes), egress bills at each edge node's avg object size, stores bill their stored data, and queues bill 3 API calls per message. Click it for the per-node breakdown and hour/day/month/year totals; a burst/ramp run gets an explicit non-steady warning, since the month bills that window on repeat. |
| **Charts** | bottom | The same signals streamed over the run's timeline. |

**DOWN** on a node means a kill is in effect at the current time. A red ring means it's the bottleneck. For a system-wide read, flip the **Glow** toggle in the timeline bar and pick its lens: utilization ρ, latency contribution, or cost share (costliest red, cheapest green). It tints every node and wire by health (green when comfortable, reddish when saturating) and lights up the slowest request's critical path. It is off by default and purely cosmetic, so turn it off on very large graphs.

### The Requests panel

Below the Inspector, the **Requests** panel lists sampled requests (with duration, hop count, and pass/fail). Click one to select it — its packets light up on the canvas while the rest dim, the clock jumps to its start, and it opens as a distributed-tracing **waterfall**: each hop is a bar split into **network** / **queue-wait** / **service**, nested by call depth, with **retries** (`↻`) and **timeouts** (`⏱`) labeled and failures in red. Hover a bar for the exact numbers. This is the "follow one request through the whole stack" view — the waterfall's total equals that request's end-to-end latency.

---

## Components

Every component is the **same queueing law with different numbers** — a "parameter profile," not a bespoke simulator. Learn the knobs once and they transfer:

- **Servers** (`concurrency` / connection pool / IO threads) — how many requests it serves at once. The hard ceiling; the rest queue.
- **Service time** (query time / GET latency / exec time) — mean time to handle one request. Sets the service rate μ.
- **Queue capacity** — how many wait for a free server before new ones are rejected.
- **Timeout / retries** (on callers) — how long to wait on a dependency, and how many times to re-issue on failure. Retries are the cascade _amplifier_.
- **Hit ratio** (on caches) — fraction of reads served from cache.

Shipped today (29 components), grouped as in the palette:

- **Networking** — Client, Browser (traffic sources), DNS, CDN (cache), CloudFront (cache), API Gateway, Reverse Proxy, Firewall, Router, Switch, Load Balancer.
- **Compute** — API, Worker, Lambda, Cron Job.
- **Storage** — Redis (cache), Memcached (cache), Postgres, MySQL, MongoDB, Cassandra, Elasticsearch, S3.
- **Messaging** — Kafka, SQS, RabbitMQ, NATS, Queue.
- **Infrastructure** — Ingress.

Hover any component or property for its exact meaning and the law it touches — **tooltips are the source of truth**, not this list.

> **"not simulated" tags.** A few knobs are still shown but tagged _not simulated_ (the remaining chaos kinds such as packet loss and clock skew, and characteristics whose law is on the deferred list). That tag is a promise: a control either changes the run or admits it doesn't yet. It never silently lies.

---

## Saving, examples, and exporting

- **Multiple systems, saved locally.** Everything persists to your browser (IndexedDB) automatically — the save status is shown in the toolbar. Switch between systems with the **systems ▾** dropdown; **New** / **Delete** manage them.
- **Examples ▾** loads a shipped scenario through the _same importer you'd use for a file_. Try:
  - **Simple CRUD API** — find the bottleneck under load.
  - **Cache Shield → Kill Redis** — a 90%-hit cache trickling 10% to Postgres, then the kill drives it to 100% and the store melts down.
  - **Retry Storm** — a tight timeout plus retries turning a saturating DB into a cascade, with no failure injection at all. Load one, tweak it, and it becomes your own saved system.
- **Import / Export ▾:**
  - **`.yantra`** — your system as a portable JSON file (the whole reproducible run: graph + seed + workloads + interventions). Share it, commit it, re-import it.
  - **Mermaid (`.mmd`)** — the topology as a diagram for docs/PRs.
  - **Report (`.md`)** — a Markdown simulation report (outcome, per-tier peak utilization, the bottleneck, injected failures). Enabled once you've run a sim.

---

## Keyboard

- **Space** — run / pause.
- **Backspace / Delete** — remove the selected node or edge.
- Standard canvas pan/zoom (scroll/drag) and a minimap.

---

## Modeling your _own_ system: a recipe

1. **Sketch the request path.** Client (or Gateway/LB) → services → datastores. One box per thing that queues.
2. **Connect in call order.** An edge means "the source calls the target while handling a request."
3. **Fill in numbers you know.** Concurrency/pool size and service time matter most. Measure from prod if you can (p50/p99, pool sizes, thread counts).
4. **Accept defaults for what you don't know** — then note it as a question for whoever owns that service. The default is a believable starting point, not a guess dressed as truth.
5. **Set the load.** The Client's `Request rate` is your λ; raise it to stress-test (e.g. to 20× your baseline) and Re-run.
6. **Run, then interrogate:** Where's the bottleneck? What's the p99? Kill your riskiest dependency, does it cascade? Push the request rate to 20×, what breaks first?

---

## What it does _not_ simulate (yet)

Honesty is a feature here — so you know exactly how far to trust a result. What the engine _does_ model is broad: parallel fan-out (wait on the slowest branch, not the sum), burst / periodic / ramp load with heavy-tailed service times, retries with backoff and circuit breakers, autoscaling, read replicas with stale reads, cache memory pressure, async brokers with consumer lag and pub/sub, DNS / TLS / keep-alive connections, sharding, and quorum replication. Still on the deferred list:

- **Link bandwidth and request payload size** aren't modeled (only link latency and jitter).
- **Chaos** beyond kill / restart / delay / partition (packet loss, clock skew, disk/memory pressure) isn't wired.
- **Kubernetes orchestration** (Node / Pod / Service scheduling, bin-packing, eviction) and **consensus** (Raft / Paxos / CRDT / Gossip) each need a new law, deliberately left for later.
- **Observability components** (Prometheus / Grafana / Jaeger / OpenTelemetry) and generic **VM / Container / Volume** resource ceilings aren't built.
- **Infrastructure importers** (Docker Compose / Kubernetes / Terraform) and a **backend / auth / cloud sync** are deferred beyond v1.

If a control might mislead you, it's tagged **not simulated**. If a component you need is missing, it's because its law isn't built — not hidden to look finished.

---

## Determinism (why results are trustworthy)

The same **graph + seed + interventions** produces a **byte-identical** run, every time. Randomness (arrival timing, hit/miss, read/write) is _seeded_ — "the same load" means the same sequence, not a similar-looking one. The seed is stored in your `.yantra` document, so a shared file replays exactly on someone else's machine. That's what makes rewind, compare, and reproducing an incident meaningful rather than decorative.
