// The referable write-up behind the "?" next to the Pre-built picker. Co-located
// with the scenario data so the explanation and the systems stay in sync. Two
// shelves, two intents: Lessons break on purpose, Companies always ship green.

export interface GuideSection {
  title: string;
  /** Paragraphs, rendered in order. */
  body: string[];
}

export const GUIDE_INTRO =
  "Every pre-built system is a real .yantra file loaded through the same importer you use. They sit on three shelves with different jobs.";

export const SHOWCASES_GUIDE: GuideSection = {
  title: "Showcases: many laws in one system",
  body: [
    "These combine several behaviors on purpose and are allowed to show real stress, a climbing backlog, a starved pool, a tripped breaker, because each one then recovers and still finishes serving.",
    "Three are focused multi-law demos (Shared Database, Kafka Backlog, Cascade & Rewind); three are big end-to-end systems (E-Commerce, Social, Streaming). Cascade & Rewind is the one to try time travel on: branch at the kill and compare the healed run against a never-healed one.",
  ],
};

export const LESSONS_GUIDE: GuideSection = {
  title: "Lessons: the curriculum",
  body: [
    "Each lesson isolates one behavioral law. Push them until they break: raise the request rate, kill a node, watch the consequence.",
    "The arc runs from the cache-death cascade through retry storms, write paths, autoscaling, replicas, fan-out, and a full stack, then circuit breakers, async backlog, sharding, and quorum.",
    "Master one by changing a single number and predicting the result before you re-run.",
  ],
};

export const COMPANIES_GUIDE: GuideSection = {
  title: "Companies: real scale, real stacks",
  body: [
    "Real architectures on the stacks the companies actually run (X on MySQL + Cassandra, Stripe on MongoDB, Reddit on Postgres + memcached), each at a request rate you can cite. No browser replays Google's global QPS, so each models one truthful cell and states the shard math, the exact estimate → shard → per-cell chain a system-design interview tests.",
    "These always ship GREEN: they deliver their stated scale with zero failures, kills and bursts included, because the shelf's job is proof the architecture holds.",
  ],
};

/** Per-scenario field notes: what to watch, how to probe it, where it breaks.
 * Keyed by the `.yantra` document id. */
export interface ScenarioNotes {
  /** What to look for while it plays. */
  watch: string;
  /** A concrete next experiment (a knob to turn, a node to kill). */
  test: string;
  /** Where this system's failure point actually is. */
  stress: string;
}

export const SCENARIO_NOTES: Record<string, ScenarioNotes> = {
  // ---- Showcases ----
  "scn-showcase-shared-db-000040": {
    watch:
      "At t=3s Orders bursts ×8 and fills the shared Postgres pool (ρ→1), so Inventory's latency spikes past 350 ms even though its own load never moved. Both recover at t=6s.",
    test: "Give Postgres a bigger pool and the contention softens; or make Inventory bursty too and watch them starve each other.",
    stress:
      "One pool, two tenants, no isolation: the noisiest neighbor's spike is paid by everyone. The fix is a pool (or rate limit) per service.",
  },
  "scn-showcase-kafka-00000041": {
    watch:
      "The producer's latency stays flat. A ×5 burst at t=2s produces ~400 msg/s into a broker that consumes ~200, so the backlog climbs to the hundreds, then drains once the burst passes at t=5s.",
    test: "Cut consumers from 6 to 2 and the backlog runs away; or set a Max backlog and see produces rejected (backpressure).",
    stress:
      "Consume capacity, not produce capacity, is the limit. A broker absorbs a spike into lag, but sustained over-production only grows it.",
  },
  "scn-showcase-cascade-0000042": {
    watch:
      "Green until t=4s, when killing Redis dumps the full read load onto a Postgres sized for 10%: ρ pins at 1, retries amplify, the breaker trips, and the fleet autoscales, all at once. Redis heals at t=7s and it climbs back.",
    test: "Branch at the t=4s kill, delete the t=7s heal on one branch, and compare: the never-healed branch stays down. Or widen the Postgres pool so it survives the loss outright.",
    stress:
      "The cache was load-bearing. Losing it is an instant ~10× overload, survivable only because the outage is transient and the breaker sheds while it lasts.",
  },
  "scn-showcase-ecommerce-047": {
    watch:
      "Twelve component types at once. A ×5 flash-sale burst at t=3s, then the CDN dies at t=4s and the flood hits the origin: the API fleets autoscale ×1→×3, the Kafka backlog climbs into the thousands, all green again once the CDN heals at 9s.",
    test: "Raise the CDN hit ratio (or delay its kill) and the origin barely notices; or shrink API Max instances and the shed lasts longer.",
    stress:
      "The CDN is load-bearing and the origin is sized for the shielded fraction, so its death is the shock. The autoscaler saves the APIs; the fulfillment backlog is the slower tail.",
  },
  "scn-showcase-social-048": {
    watch:
      "A viral post ramps traffic from zero over 4s and the API fleets autoscale in. At t=5s the Redis feed cache dies and the read load falls onto quorum Cassandra and MySQL replicas, absorbed with zero failures until the cache heals at 8s.",
    test: "Drop the feed hit ratio to lean harder on the stores; or lower the posts store's quorum (W and R) and a stale-read rate appears.",
    stress:
      "Unlike the e-commerce origin, this store tier survives the cache loss outright, so the feed death is absorbed, not a cascade. The API fleet is elastic; the stores are the fixed floor.",
  },
  "scn-showcase-streaming-049": {
    watch:
      "The widest system here, fifteen component types. A global-launch ramp while the API fans out to memcached, a 5-shard Elasticsearch, Cassandra, S3, and an SQS transcode pipeline. At t=7s one search shard is killed: only the ~1/5 hashing to it fail, the rest serve on, healed at 10s.",
    test: "Kill a different shard (or two) from the Inspector's per-cell control; or raise the shard count and the search ceiling climbs.",
    stress:
      "Sharding isolates the failure to one key slice instead of all of search; the CDN offload keeps the origin sane; the transcode queue decouples uploads from the request path.",
  },
  "scn-showcase-frankenstein-051": {
    watch:
      "All 29 component types in one working graph. Traffic ramps to ~1,500 req/s through web and mobile front doors into an autoscaled API fanning out to eight stores and five buses. Over-provisioned end to end, so utilization stays low and nothing fails.",
    test: "Turn on the Lens to read the whole system's health, then Inject a failure anywhere (kill Redis, partition Cassandra, delay S3) and watch the over-built rest absorb it.",
    stress:
      "The opposite of the other showcases: no bottleneck until you make one. It's the reference build for seeing the whole catalog together, and a sandbox for breaking one piece at a time.",
  },

  // ---- Lessons ----
  "scn-cache-shield-0000-000000000002": {
    watch:
      "Postgres is idle until t=5s, when killing Redis drops h to 0: the full read load floods the 6-connection pool, retries pile on, and requests fail.",
    test: "Move the kill earlier or later, or give Postgres a bigger pool and see how much cache-loss it absorbs before failing.",
    stress:
      "The cache-death cliff: the DB was sized for 10% of reads, so at 100% it's ~10× over capacity, with no graceful degradation.",
  },
  "scn-retry-storm-0000-000000000003": {
    watch:
      "The 80 ms timeout fires before the 25 ms/query Postgres can drain under load, so each request retries up to 3×, offered load multiplies, and throughput collapses.",
    test: "Raise the timeout to 1000 ms or set retries to 0 and the storm subsides: the same hardware suddenly copes.",
    stress:
      "A too-tight timeout against a saturating tier turns latency into duplicated load, the amplifier behind real cascades.",
  },
  "scn-lesson-writes-000000000036": {
    watch:
      "Even with a perfect cache (h=1), Postgres still runs at ρ≈0.5, because the 50% writes bypass the cache and hit the 8-connection pool directly.",
    test: "Slide the write ratio from 0 to 1 and Postgres load tracks it exactly; the hit rate never helps the write path.",
    stress:
      "The write path has no cache to hide behind: a read-heavy cache is no defense once writes dominate.",
  },
  "scn-autoscale-flash-00000032": {
    watch:
      "5,200 req/s hits one API instance; it sheds load for ~1-2s (the boot delay), then the fleet steps ×1→×5, failures stop, and the bottleneck moves to Postgres.",
    test: "Lower Max instances to 2 and it saturates like a fixed tier; or raise the target utilization and it runs hotter with less headroom.",
    stress:
      "Autoscaling lags the spike, so the first seconds always hurt, and it only moves the wall: once the fleet is big enough, Postgres is the next limit.",
  },
  "scn-lesson-replicas-00000037": {
    watch:
      "Reads spread across 2 replicas (3× read capacity), writes stay on the primary. The Postgres node shows a live ~⅓ stale-read rate at the 20 ms lag and 5% writes.",
    test: "Raise the replication lag or write ratio and the stale-read rate climbs, following 1 − e^(−λ_write·lag).",
    stress:
      "Replicas add read capacity, not write capacity, and buy it with staleness: a read-after-write inside the lag window sees old data.",
  },
  "scn-lesson-fanout-000000000038": {
    watch:
      "The request visits MongoDB, then Elasticsearch, then S3 in turn, so end-to-end latency is the sum. Open a request and S3 (40 ms) dominates the waterfall.",
    test: "Select the API, flip Fan-out to 'parallel', and latency collapses toward the slowest branch (~40 ms) instead of the sum (~70 ms).",
    stress:
      "Sequential fan-out stacks every dependency's latency. Parallelism fixes it, but only for independent calls; a true chain can't be parallelized.",
  },
  "scn-lesson-fullstack-00000039": {
    watch:
      "Everything at once: the CDN absorbs 85% at the edge, the API autoscales, Postgres replicas serve reads with a small stale rate, then the CDN dies at 5s and the origin ramps to catch it.",
    test: "Kill different nodes (Redis, a replica) to watch each failure propagate, or adjust Max instances to see the autoscaler's headroom.",
    stress:
      "Multiple coupled limits, with the CDN death the big one: the origin fleet must autoscale fast enough to absorb the offloaded traffic.",
  },
  "scn-lesson-breaker-000000000043": {
    watch:
      "Lesson 2's storm, but the breaker trips OPEN when Postgres failures cross 50% and fast-fails, resting the DB; a half-open probe after the cooldown restores traffic, so throughput recovers in bursts instead of pinning at zero.",
    test: "Open this and Lesson 2 side by side: Lesson 2 flatlines at zero, this one keeps clawing back. Widen the cooldown and the recovery windows lengthen.",
    stress:
      "A breaker is not more capacity: it turns a self-sustaining storm into an oscillation, so a permanently-overloaded tier still can't serve every request.",
  },
  "scn-lesson-async-000000000044": {
    watch:
      "The producer publishes 150 msg/s and returns immediately; the 4 consumers drain only ~100 msg/s, so the Kafka backlog climbs steadily (produced minus consumed).",
    test: "Raise consumers to 8 (or drop the produce rate below ~100) and the backlog stops growing, exactly where consume capacity meets produce rate.",
    stress:
      "Below the produce rate, lag grows without bound and the producer never feels it, the whole point, and the whole danger, of async decoupling.",
  },
  "scn-lesson-sharding-000000045": {
    watch:
      "The index is 4 independent shards; each request hashes to one. Green until t=5s, when shard 1 is killed: only the ~1/4 hashing to it fail, the other three serve at full speed.",
    test: "Raise the shard count and the aggregate ceiling climbs (each shard adds a pool); or raise the client rate to push a single shard toward saturation.",
    stress:
      "Sharding buys capacity and fault isolation but not even spread: a hot key saturates its one shard, and a dead shard's slice is unavailable until it heals.",
  },
  "scn-lesson-quorum-0000000046": {
    watch:
      "The Cassandra node shows a ~⅔ stale-read rate: at RF=3, W=R=1, a one-replica read misses the just-written replica two times in three.",
    test: "Raise Write and Read quorum to 2 each (W+R=4 > RF=3) and every read overlaps the write, staleness drops to zero. Drop them and it climbs back.",
    stress:
      "Consistency vs latency is the dial: strong quorum (W+R > RF) costs more acks and tolerates fewer node losses; a weak one is fast but reads old data.",
  },

  // ---- Companies ----
  "scn-netflix-0000-0000-000000000010": {
    watch:
      "Pre-kill, the origin sits near idle (the 95% CDN + EVCache do the work). At t=4s the CDN dies, 20× lands on the origin, ρ jumps an order of magnitude, and the pre-provisioned ×5 fleet swallows it with zero failures.",
    test: "Trim Min instances to 1 to watch the autoscaler do it reactively (with a visible shed) instead of via headroom. Then open the cost readout: at list rates the CDN egress alone runs ~$1.8M/month; set Egress to 0.008 $/GB (an owned edge box) and it drops ~10×.",
    stress:
      "Kill the CDN and the origin sees ~20× load instantly, survivable only via pre-provisioned headroom (Netflix's Chaos-Kong posture). ~21 PB/month of egress at list rates is why Netflix built its own edge boxes racked inside ISPs.",
  },
  "scn-youtube-watch-000000000021": {
    watch:
      "A fixed (non-autoscaled) fleet fronts the 95% CDN, comfortable at 5,000 req/s; the S3 media fetch's lognormal tail keeps p99 well above the mean.",
    test: "Kill the CDN and watch the fixed fleet absorb the flood at high ρ, the deliberate contrast to Netflix's autoscaled rescue.",
    stress:
      "No autoscaler means no elastic headroom: the fleet is sized for a CDN-fronted load, and a sustained CDN loss would push it to its ceiling.",
  },
  "scn-x-timeline-0000-000000000011": {
    watch:
      "On a cache miss the tweet store (Cassandra) and user store (MySQL) are hit in parallel, so latency tracks the slower. Cassandra runs strong quorum (W+R>RF, no stale tweets); MySQL shows a ~⅓ stale-read rate from its replicas at 10 ms lag.",
    test: "Drop Cassandra's quorum to W=R=1 and stale tweets appear (W+R ≤ RF); or raise MySQL's writes and its replica stale rate rises.",
    stress:
      "Two replication models side by side: MySQL's single-primary replicas (stale by lag) and Cassandra's masterless quorum (stale by weak quorum). The Redis cache keeps both stores' load sane.",
  },
  "scn-instagram-feed-00000000022": {
    watch:
      "Parallel feed hydration on a cache miss over jittery mobile links, so leg latency spreads. Postgres replicas serve reads and the stale rate tracks the low write rate.",
    test: "Increase the link jitter to widen the latency distribution, or drop the Redis hit ratio to lean more load onto Cassandra and the replicas.",
    stress:
      "The Redis feed cache shields the stores and the replica pool scales reads; writes and misses fan out to every backing store at once.",
  },
  "scn-reddit-sub-00000000000023": {
    watch:
      "The memcached shield keeps the modest 20-connection Postgres pool at ρ≈0.35 even at 3,000 req/s: comfortable, green, no drama.",
    test: "Kill memcached yourself to reproduce Lesson 1's cache-death cascade, now at production scale.",
    stress:
      "The pool is small on purpose; it survives only because h=0.9 hides 90% of reads. Remove the shield and it's ~5× over capacity.",
  },
  "scn-google-search-000000027": {
    watch:
      "The query cache (h=0.7) fronts the shard tier (lognormal tail). At t=6s the cache dies, shard load jumps ~3×, absorbed at ρ≈0.83, but p99 spikes first.",
    test: "Vary the cache hit ratio and shard load scales as (1−h)·λ: a 70% hit rate cuts backend load to a third.",
    stress:
      "Cache arithmetic at scale: the shards assume the cache absorbs 70%, so losing it triples their load and pushes p99 hard even though throughput holds.",
  },
  "scn-amazon-product-000000025": {
    watch:
      "The product page fans out to Postgres, Cassandra recs, and Elasticsearch in parallel behind a Redis cache, so page latency tracks the slowest branch, not the sum.",
    test: "Flip the API's fan-out to sequential and latency balloons; or raise the write ratio (add-to-cart) and writes bypass the cache to the stores.",
    stress:
      "The slowest branch (usually Elasticsearch) sets page latency: any one backing store slowing drags the whole page.",
  },
  "scn-spotify-play-0000000000024": {
    watch:
      "Every play resolves metadata in Cassandra, then fetches the audio object (lognormal tail), a sequential chain the object fetch dominates.",
    test: "Flip fan-out to parallel and note it barely helps: the audio fetch depends on the metadata, so the chain can't collapse.",
    stress:
      "Latency accumulation on a true chain: you can't parallelize a dependency, so the slow object store is the floor on play-start.",
  },
  "scn-stripe-charge-000000029": {
    watch:
      "90% writes bypass the Redis cache straight to MongoDB, and every charge also calls the fraud Lambda, which sits on the critical path.",
    test: "Raise the load and watch whether MongoDB's pool or the Lambda's concurrency binds first; drop the write ratio to see the cache finally help.",
    stress:
      "The write path plus a synchronous fraud check: if the Lambda slows, every charge slows, cache or not.",
  },
  "scn-uber-matching-000000033": {
    watch:
      "The autoscaled matching fleet grows with load. The Redis geo-index runs a low ~50% hit rate (locations churn), so MySQL trips and Postgres riders carry real load.",
    test: "Raise the request rate to simulate rush hour and the fleet scales to meet it; lower the geo-cache hit ratio to lean harder on the stores.",
    stress:
      "The low geo-cache hit rate means the stores can't be shielded much: matching capacity is elastic, but the rider/trip stores are the fixed limit.",
  },
  "scn-irctc-tatkal-00000050": {
    watch:
      "Set the horizon to 30s first. Calm until t=4s, when the Tatkal gate opens and a ×8 burst hits: the app fleet autoscales ×2→×8, but the 18-connection booking pool (the seat lock) pins at ρ=1, so the wait climbs toward ~10s. The fleet scales back after the burst and the backlog drains by ~t=28s.",
    test: "Change the app tier's Max instances, it barely moves the outcome, because the bottleneck is the fixed seat pool. Widen the booking pool instead and the ceiling actually moves.",
    stress:
      "The seat pool is the hard limit, exactly the number of Tatkal berths. Autoscaling the app tier lets everyone into the queue but creates no seats: availability-as-latency, not availability-as-errors.",
  },
};
