// The referable write-up behind the "?" next to the Pre-built picker. Co-located
// with the scenario data so the explanation and the systems stay in sync. Two
// shelves, two intents: Lessons break on purpose, Companies always ship green.

export interface GuideSection {
  title: string;
  /** Paragraphs, rendered in order. */
  body: string[];
}

export const GUIDE_INTRO =
  "Every pre-built system is a real .yantra file loaded through the same importer you use, nothing is a special code path. They sit on three shelves with different jobs.";

export const SHOWCASES_GUIDE: GuideSection = {
  title: "Showcases: many laws in one system",
  body: [
    "The last shelf combines multiple behaviors on purpose, and unlike the Companies shelf these are allowed to show real stress: a backlog that climbs, a pool that starves, a breaker that trips, a fleet that scales. That stress is the point, because each one then recovers, and every showcase still finishes serving requests.",
    "Three are focused two-or-three-law demos: Shared Database (two services starving one pool), Kafka: Decoupling & Backlog (a burst past consume capacity), and Cascade & Rewind (kill Redis and watch retries, the breaker, and the autoscaler all fire, then heal).",
    "Three are big end-to-end systems that put a dozen-plus component types on one canvas at once: E-Commerce (a Black-Friday flash sale with a CDN failure), Social Network (a viral ramp with a dying feed cache), and Streaming Platform (the widest graph here, a global launch with a sharded search and a transcode pipeline). Open one, run it, and click any node to watch its piece of the whole.",
    "Cascade & Rewind is also the place to try time travel: branch the timeline at the kill and compare the healed run against a never-healed one to see the breaker and autoscaler earn their keep.",
  ],
};

export const LESSONS_GUIDE: GuideSection = {
  title: "Lessons: the curriculum",
  body: [
    "I have added a few systems, each isolating one behavioral law, in the order I'd learn them. They are meant to be pushed until they break: raise the client's request rate, kill a node, and watch the consequence.",
    "The arc builds: 1 a single queue and where ρ saturates → 2 scale out behind a load balancer and survive a backend dying → 3 add a cache → 4 kill that cache and watch the cascade → 5 a retry storm amplifying load → 6 why a perfect cache still can't shield writes → 7 autoscaling that lags the spike → 8 read replicas and the stale reads they cause → 9 fan-out and the critical path → 10 a full stack that combines all of it.",
    "Master a lesson by changing one number and predicting the result before you re-run. When an interview asks 'what happens if…', you'll have watched it.",
  ],
};

export const COMPANIES_GUIDE: GuideSection = {
  title: "Companies: real scale, real stacks",
  body: [
    "Another section with some real architectures, each on the stack the company actually runs (X on MySQL + Cassandra, Stripe on MongoDB, Reddit on Postgres + memcached, Instagram on Postgres read replicas) at a request rate you can cite and see.",
    "No browser can replay Google's global 100K QPS event-by-event, and no real Google serves it as one blob, production is cell and region-sharded. So each system models one cell at a truthful per-cell rate, and its description states both the global figure and the shard math. That's exactly the estimate → shard → per-cell-load chain a system-design interview is testing.",
    "These always ship GREEN: they deliver their stated scale with zero failures, kills and bursts included, because the shelf's job is PROOF that the architecture holds. Read the real(or close enough) number, study a configuration that genuinely serves it, and you have real-world proof to calibrate against later.",
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
      "Baseline, both services sit around 55 ms. At t=3s Orders bursts ×8 and the shared Postgres pool saturates (ρ→1, queue hundreds deep), so mean latency climbs past 350 ms, Inventory included, even though Inventory's own 250 req/s never moved. It recovers when the burst ends at t=6s.",
    test: "Give Postgres a bigger connection pool and watch the contention soften; or make Inventory bursty too and see them starve each other.",
    stress:
      "One connection pool, two tenants. There is no isolation, so the noisiest neighbor's spike is paid by everyone on the pool. The fix is a separate pool (or a rate limit) per service.",
  },
  "scn-showcase-kafka-00000041": {
    watch:
      "The producer's latency stays flat at the publish cost throughout. At t=2s a ×5 burst produces ~400 msg/s into a broker that consumes ~200, so the backlog (consumer lag) climbs to the hundreds, then drains back to zero once the burst passes at t=5s.",
    test: "Cut the consumers from 6 to 2 and watch the backlog run away instead of draining; or set a Max backlog and see produces get rejected (backpressure) once it fills.",
    stress:
      "Consume capacity, not produce capacity. A broker absorbs a spike into lag, but sustained over-production only grows the lag, decoupling buys you time to catch up, not infinite headroom.",
  },
  "scn-showcase-cascade-0000042": {
    watch:
      "Green until t=4s, when Redis is killed: h→0 dumps the full read load onto a Postgres sized for 10%, ρ pins at 1, retries amplify, the breaker trips, and the API fleet autoscales, all at once. Failures spike and throughput craters. At t=7s Redis heals and the system climbs back to green.",
    test: "This is the time-travel showcase: branch at the t=4s kill, delete the t=7s heal on one branch, and compare, the never-healed branch stays down while the healed one recovers. Then try widening the Postgres pool so it survives the cache loss outright.",
    stress:
      "The cache was load-bearing. Postgres is provisioned for the shielded 10%, so losing Redis is an instant ~10× overload, survivable here only because the outage is transient and the breaker sheds while it lasts.",
  },
  "scn-showcase-ecommerce-047": {
    watch:
      "Twelve component types working at once. At t=3s a ×5 flash-sale burst hits; at t=4s the CDN dies and the full flood lands on the origin. Watch the two API fleets autoscale ×1→×3 (with a brief shed you'll see as a failure blip), the Kafka order-event backlog climb into the thousands, and everything recover to green once the CDN heals at 9s.",
    test: "Raise the CDN hit ratio (or move its kill later) and watch the origin barely notice; or shrink the API Max instances and see the shed last longer. Open the Kafka node to watch the fulfillment backlog drain.",
    stress:
      "The CDN is load-bearing and the origin is sized for the shielded fraction, so its death is the big shock. The autoscaler moves the wall (the APIs recover) but the fulfillment pipeline's backlog is the slower tail.",
  },
  "scn-showcase-social-048": {
    watch:
      "A viral post ramps traffic from zero over 4s. The API fleets (with keep-alive connections and a breaker) autoscale into the surge. At t=5s the Redis feed cache dies and the full read load falls onto the quorum Cassandra posts and the MySQL user replicas, which absorb it with zero failures until the cache heals at 8s.",
    test: "Drop the CloudFront or feed hit ratio to lean harder on the stores; or lower the posts store's quorum (W and R) and watch a stale-read rate appear while it's under load.",
    stress:
      "Unlike the e-commerce origin, this store tier is provisioned to survive the cache loss outright, so the feed death is absorbed, not a cascade. The elastic part is the API fleet; the stores are the fixed floor.",
  },
  "scn-showcase-streaming-049": {
    watch:
      "The widest system in the library, fifteen component types including a background Cron cleanup job. A global-launch ramp climbs while the API (with CPU contention) fans out to memcached, a 5-shard Elasticsearch, quorum Cassandra, S3 media, and an SQS transcode pipeline. At t=7s one search shard is killed: only the ~1/5 of queries that hash to it fail, the other four shards serve on, and it recovers when the shard restarts at 10s.",
    test: "Kill a different search shard from the Inspector's per-cell control, or kill two at once; or raise the shard count and watch the aggregate search ceiling climb. Open the SQS node to watch the transcode backlog.",
    stress:
      "Sharding isolates the failure to one key slice instead of taking down all of search, and the CDN offload keeps the origin sane. The transcode queue is the async tail that decouples uploads from the request path.",
  },
  "scn-showcase-frankenstein-051": {
    watch:
      "Every one of the 29 component types in a single graph, wired into a working system. Traffic ramps to ~1,500 req/s across a web front door (CloudFront) and a mobile one (CDN), each falling through a full networking chain into an autoscaled API that fans out in parallel to eight stores and five message buses. Watch how little any one tier sweats: because it is over-provisioned end to end, utilization stays low and nothing fails.",
    test: "Turn on Glow in the timeline bar to read the whole system's health at a glance, then pick any node and Inject a failure, kill Redis, partition Cassandra, delay S3, and watch the over-built rest absorb it. Raise the Client and Browser request rates to find which tier saturates first.",
    stress:
      "The lesson is the opposite of the other showcases: spared no expense, so there is no bottleneck until you make one. It is the reference build for seeing the full catalog behave together, and a sandbox for breaking one piece at a time.",
  },

  // ---- Lessons ----
  "scn-crud-api-0000-0000-000000000001": {
    watch:
      "Postgres is the busy tier (ρ highest) while the API sits nearly idle, the 50-connection pool at 15 ms tops out near 3,300 req/s, far below the API's ceiling.",
    test: "Raise the Client's request rate and watch which node reaches ρ=1 first; then raise the pool or drop query time and see the bottleneck move.",
    stress:
      "The Postgres connection pool. Past ~3,300 req/s its queue fills and latency diverges, the classic 'the database is the bottleneck' result.",
  },
  "scn-lesson-scale-out-00000034": {
    watch:
      "At t=4s api-b dies; its share of traffic shifts to api-a and api-c (they run hotter), not a third of requests failing. At t=7s it rejoins and load re-balances.",
    test: "Change the LB algorithm to least-connections and compare recovery; or kill a second API and watch the survivors approach saturation.",
    stress:
      "Each API is only 8 threads (~800 req/s). Two of three surviving 900 req/s is fine; kill two and the lone survivor saturates.",
  },
  "scn-lesson-add-cache-00000035": {
    watch:
      "The Redis node shows a live ~90% hit rate; Postgres load sits near (1−0.9)·reads + writes, a fraction of the 500 req/s, so the tiny 6-connection pool copes.",
    test: "Drag Redis's hit ratio down toward 0 and watch Postgres load climb linearly, DB load ≈ (1−h)·read λ, exactly.",
    stress:
      "The cache does the shielding. At h=0.9 the DB is comfortable; drop h below ~0.6 and the 6-connection pool starts to saturate.",
  },
  "scn-cache-shield-0000-000000000002": {
    watch:
      "Postgres is idle until t=5s, when Redis is killed, then h collapses to 0, the full read load floods the 6-connection pool, retries pile on, and requests fail.",
    test: "Move the kill earlier/later, or give Postgres a bigger pool and see how much cache-loss it can absorb before failing.",
    stress:
      "The cache-death cliff. The DB was provisioned for 10% of reads; at 100% it's ~10× over capacity, no graceful degradation.",
  },
  "scn-retry-storm-0000-000000000003": {
    watch:
      "The 80 ms timeout fires before the 25 ms-per-query Postgres can drain its queue under load, so each request retries up to 3×, offered load multiplies and throughput collapses.",
    test: "Raise the timeout to 1000 ms or set retries to 0 and watch the storm subside, the same hardware suddenly copes.",
    stress:
      "Timeout + retries against a saturating tier. A too-tight timeout turns latency into duplicated load, the amplifier behind real cascades.",
  },
  "scn-lesson-writes-000000000036": {
    watch:
      "Even with a PERFECT cache (h=1), Postgres still runs at ρ≈0.5, because the 50% writes bypass the cache entirely and land straight on the 8-connection pool.",
    test: "Slide the write ratio from 0 to 1 and watch Postgres load track it exactly; the cache hit rate never helps the write path.",
    stress:
      "The write path has no cache to hide behind. A read-heavy cache is no defense once writes dominate, the store must carry every one.",
  },
  "scn-autoscale-flash-00000032": {
    watch:
      "5,200 req/s hits a single API instance; it sheds load for ~1–2 s (the boot delay), then the fleet steps ×1→×5, failures stop, and the bottleneck moves to Postgres.",
    test: "Lower Max instances to 2 and watch it saturate like a fixed tier; or raise the target utilization and see it run hotter with less headroom.",
    stress:
      "Autoscaling LAGS the spike, the first seconds always hurt. And it only moves the wall: once the fleet is big enough, Postgres becomes the next limit.",
  },
  "scn-lesson-replicas-00000037": {
    watch:
      "Reads spread across the 2 replicas (3× the read capacity); writes stay on the primary. The Postgres node shows a live stale-read %, ~⅓ at the 20 ms lag and 5% writes.",
    test: "Raise the replication lag or the write ratio and watch the stale-read rate climb, it follows 1 − e^(−λ_write·lag).",
    stress:
      "Replicas add READ capacity, not write capacity, and buy it with staleness. A read-after-write inside the lag window sees old data.",
  },
  "scn-lesson-fanout-000000000038": {
    watch:
      "The request visits MongoDB, then Elasticsearch, then S3 in turn, end-to-end latency is the SUM. Open a request in the inspector and S3 (40 ms) dominates the waterfall.",
    test: "Select the API, flip its Fan-out knob to 'parallel', re-run, and watch latency collapse toward the slowest single branch (~40 ms) instead of the sum (~70 ms).",
    stress:
      "Sequential fan-out stacks every dependency's latency. The fix is parallelism, but only for independent calls; a true dependency chain can't be parallelized.",
  },
  "scn-lesson-fullstack-00000039": {
    watch:
      "Everything at once: the CDN absorbs 85% at the edge, the autoscaled API scales with load, Postgres replicas serve reads with a small stale rate, then the CDN dies at 5s and the origin ramps up to catch it.",
    test: "Kill different nodes (Redis, a replica) and watch how each failure propagates; adjust Max instances to see the autoscaler's headroom.",
    stress:
      "Multiple coupled limits. The CDN death is the big one, the origin fleet must autoscale fast enough to absorb the offloaded traffic.",
  },
  "scn-lesson-breaker-000000000043": {
    watch:
      "Same storm as Lesson 5, but the breaker cuts in: when the Postgres failure rate crosses 50% it trips OPEN and fast-fails, which rests the DB. A half-open probe after the cooldown finds it healthy and restores traffic, so throughput recovers in bursts instead of pinning at zero.",
    test: "Open both this and Lesson 5 and compare the throughput trace, Lesson 5 flatlines at zero after the storm starts, this one keeps clawing back. Widen the cooldown and watch the recovery windows lengthen.",
    stress:
      "A breaker is not more capacity. It converts a self-sustaining retry storm into an oscillation, trading fast-fails for periodic recovery, so a permanently-overloaded tier still can't serve every request.",
  },
  "scn-lesson-async-000000000044": {
    watch:
      "The producer publishes 150 msg/s and returns immediately (latency stays at the link cost). The 4 consumers drain only ~100 msg/s, so the Kafka node's consumer lag (backlog) climbs steadily, produced minus consumed, with nothing downstream to blame.",
    test: "Raise the consumers to 8 (or drop the produce rate below ~100) and watch the backlog stop growing; the crossover is exactly where consume capacity meets produce rate.",
    stress:
      "Consume capacity = consumers / consume time. Below the produce rate the lag grows without bound; the producer never feels it, which is the whole point and the whole danger of async decoupling.",
  },
  "scn-lesson-sharding-000000045": {
    watch:
      "The index is 4 independent shards; each request hashes to one. Green until t=5s, when shard 1 is killed: only the ~1/4 of requests that hash to it start failing, while the other three shards keep serving at full speed.",
    test: "Raise the Elasticsearch shard count and watch the aggregate ceiling climb (each shard adds a full pool); or raise the client rate to push a single shard toward saturation.",
    stress:
      "Sharding buys capacity and fault isolation, but at the cost of even spread: a hot key (skewed hashing) saturates its one shard while the others idle, and a dead shard's key slice is simply unavailable until it heals.",
  },
  "scn-lesson-quorum-0000000046": {
    watch:
      "The Cassandra node shows a live stale-read rate near ⅔. With RF=3 and W=R=1, a read of one replica misses the one just-written replica two times in three, the quorum-overlap probability C(2,1)/C(3,1).",
    test: "Raise Write quorum and Read quorum to 2 each: now W+R=4 > RF=3, every read is guaranteed to overlap the write, and the stale rate drops to zero. Then drop RF or the quorums and watch it climb back.",
    stress:
      "Consistency vs latency/availability is the dial. Strong quorum (W+R > RF) costs more acks per op and tolerates fewer node losses; a weak one is fast and available but reads old data. There is no free lunch, only the setting you chose.",
  },

  // ---- Companies ----
  "scn-netflix-0000-0000-000000000010": {
    watch:
      "Pre-kill the origin sits near idle (the 95% CDN + EVCache do the work). At t=4s the CDN dies, 20× lands on the origin, ρ jumps an order of magnitude, and the ×5 pre-provisioned fleet swallows it with zero failures.",
    test: "Trim Min instances to 1 and re-run to watch the autoscaler do it reactively (with a visible shed during the boot delay) instead of via headroom. Then open the cost readout: at CloudFront list rates the CDN's egress alone runs ~$1.8M/month. Set the CDN's Egress rate to 0.008 $/GB (an owned edge appliance, amortized) and re-run: that line drops ~10×.",
    stress:
      "The CDN offload magnitude. Kill it and the origin sees ~20× its normal load instantly, survivable only because of pre-provisioned headroom (Netflix's Chaos-Kong posture). The bill tells the same story: ~21 PB/month of egress at per-GB list rates is why Netflix built OpenConnect, its own edge boxes racked inside ISPs, paying for hardware once instead of every GB.",
  },
  "scn-youtube-watch-000000000021": {
    watch:
      "A fixed (non-autoscaled) fleet fronts the 95% CDN. It runs comfortably at 5,000 req/s; the S3 media fetch carries a lognormal tail, so p99 sits well above the mean.",
    test: "Kill the CDN and watch the FIXED fleet absorb the flood at high ρ, the deliberate contrast to Netflix's autoscaled rescue.",
    stress:
      "No autoscaler means no elastic headroom. The fixed fleet is sized for a CDN-fronted load; a sustained CDN loss would push it to its ceiling.",
  },
  "scn-x-timeline-0000-000000000011": {
    watch:
      "On a cache miss the tweet store (Cassandra) and user store (MySQL) are hit in PARALLEL, so latency tracks the slower of the two. Cassandra is a masterless ring (6 nodes, RF=3, W=R=2 so W+R>RF, no stale tweets); the MySQL node shows a live ~⅓ stale-read rate from its 2 replicas at 10 ms lag.",
    test: "Drop Cassandra's write/read quorum to 1 each and watch a stale-tweet rate appear (W+R ≤ RF); or turn MySQL's writes up and see its replica stale-read rate rise.",
    stress:
      "Two different replication models side by side: MySQL's single-primary read replicas (stale by lag) and Cassandra's masterless quorum (stale by weak quorum). The hot Redis cache is what keeps both stores' load sane.",
  },
  "scn-instagram-feed-00000000022": {
    watch:
      "Parallel feed hydration on a cache miss over jittery mobile links (the client link carries jitter, so leg latency spreads). Postgres replicas serve reads; the stale rate tracks the low write rate.",
    test: "Increase the link jitter and watch the latency distribution widen; drop the Redis hit ratio to lean more load onto Cassandra and the replicas.",
    stress:
      "The feed cache (Redis) shields the stores; the replica pool scales reads. Writes and cache misses fan out to every backing store at once.",
  },
  "scn-reddit-sub-00000000000023": {
    watch:
      "The memcached shield keeps the modest 20-connection Postgres pool at ρ≈0.35 even at 3,000 req/s, comfortable, green, no drama.",
    test: "Open Failure injection and kill memcached yourself to reproduce Lesson 4's cache-death cascade, now at production scale.",
    stress:
      "The pool is small on purpose, it only survives because h=0.9 hides 90% of reads. Remove the shield and it's ~5× over capacity.",
  },
  "scn-google-search-000000027": {
    watch:
      "The query cache (h=0.7) fronts the shard tier; the shards' Elasticsearch carries a lognormal tail. At t=6s the cache dies and shard load jumps ~3×, absorbed at ρ≈0.83, but the p99 spikes first.",
    test: "Vary the cache hit ratio and watch shard load scale as (1−h)·λ; a 70% hit rate cuts backend load to a third.",
    stress:
      "Cache arithmetic at scale. The shards are sized assuming the cache absorbs 70%; losing it triples their load and pushes p99 hard even though throughput holds.",
  },
  "scn-amazon-product-000000025": {
    watch:
      "The product page fans out to Postgres, Cassandra recs, and Elasticsearch IN PARALLEL behind a Redis cache, page latency tracks the slowest branch, not the sum of all three.",
    test: "Flip the API's fan-out to sequential and watch latency balloon; or raise the write ratio (add-to-cart) and see writes bypass the cache to the stores.",
    stress:
      "The slowest branch (usually Elasticsearch) sets the page latency. Any one backing store slowing down drags the whole page with it.",
  },
  "scn-spotify-play-0000000000024": {
    watch:
      "Every play resolves metadata in Cassandra, THEN fetches the audio object (lognormal tail), a dependency chain, inherently sequential. The object fetch dominates the critical path.",
    test: "Try flipping fan-out to parallel and note it barely helps, the audio fetch depends on the metadata, so the chain can't collapse.",
    stress:
      "Latency accumulation on a true chain. You can't parallelize a dependency; the slow object store is the floor on play-start time.",
  },
  "scn-stripe-charge-000000029": {
    watch:
      "90% writes bypass the Redis cache straight to MongoDB, and every charge also calls the fraud Lambda, which sits on the critical path, adding its latency to each request.",
    test: "Raise the load and watch whether MongoDB's pool or the Lambda's concurrency binds first; drop the write ratio to see the cache finally help.",
    stress:
      "The write path plus a synchronous fraud check. The Lambda is on the critical path, if it slows, every charge slows, cache or not.",
  },
  "scn-uber-matching-000000033": {
    watch:
      "The autoscaled matching fleet grows with load. The Redis geo-index runs a low ~50% hit rate (locations churn), so MySQL trips and Postgres riders carry real load.",
    test: "Raise the Client's request rate to simulate rush hour and watch the matching fleet scale up to meet it; lower the geo-cache hit ratio to lean harder on the stores.",
    stress:
      "The low geo-cache hit rate means the stores can't be shielded much. Matching capacity is the elastic part; the rider/trip stores are the fixed limit.",
  },
  "scn-irctc-tatkal-00000050": {
    watch:
      "Set the timeline horizon to 30s first (the default 15s only shows the ramp-up). Then watch the full arc: calm until t=4s, when the Tatkal gate opens and a ×8 burst hits. The app fleet autoscales ×2→×8 to take everyone in, but the 18-connection booking pool (the seat lock) pins at ρ=1, so throughput ceilings and the wait climbs toward ~10s. The burst ends at 12s; a few seconds later the fleet scales back down to ×2, and the seat backlog drains until latency returns to zero around t=28s.",
    test: "Change the app tier's Max instances, it barely moves the outcome, because the bottleneck is the fixed seat pool, not the app fleet. Widen the booking pool instead and watch the ceiling (and the wait) actually move. Or shrink the queue/timeouts and it collapses into Lesson 5's retry storm.",
    stress:
      "The seat pool is the hard limit, exactly the number of Tatkal berths. Autoscaling the stateless app tier lets everyone into the queue but creates no seats: it trades availability-as-errors for availability-as-latency, which is why Tatkal feels like a lottery, not an outage. The fleet scales up fast but down slowly (the autoscaler's deliberate anti-flap delay).",
  },
};
