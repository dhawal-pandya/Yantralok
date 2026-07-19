// Pre-built systems. Each is a real `.yantra` file loaded through the same import
// pipeline users use: the `raw` text is fed to the normal importer, never a
// special builder. The catalog adds only presentational metadata. Three shelves:
//   SHOWCASES, several laws combined on purpose, allowed to show real stress
//   (a growing backlog, a starved pool, a tripped breaker) because recovering is
//   the point; each still finishes serving requests.
//   LESSONS, a numbered curriculum, one law per lesson, in teaching order.
//   COMPANIES, real-world architectures on their real stacks, showing the engine
//   at full stretch (autoscaling, read replicas, cascades).
import sharedDb from "./showcase-shared-db.yantra?raw";
import kafkaBacklog from "./showcase-kafka-backlog.yantra?raw";
import cascadeRewind from "./showcase-cascade-rewind.yantra?raw";
import ecommerce from "./showcase-ecommerce.yantra?raw";
import social from "./showcase-social.yantra?raw";
import streaming from "./showcase-streaming.yantra?raw";
import frankenstein from "./showcase-frankenstein.yantra?raw";
import circuitBreaker from "./lesson-circuit-breaker.yantra?raw";
import asyncMessaging from "./lesson-async-messaging.yantra?raw";
import sharding from "./lesson-sharding.yantra?raw";
import quorum from "./lesson-quorum.yantra?raw";
import cacheShield from "./cache-shield.yantra?raw";
import retryStorm from "./retry-storm.yantra?raw";
import readsWrites from "./lesson-reads-writes.yantra?raw";
import autoscaleFlash from "./autoscale-flash.yantra?raw";
import readReplicas from "./lesson-read-replicas.yantra?raw";
import fanout from "./lesson-fanout.yantra?raw";
import fullStack from "./lesson-full-stack.yantra?raw";
import netflix from "./netflix-streaming.yantra?raw";
import youtube from "./youtube-watch.yantra?raw";
import xTimeline from "./x-timeline.yantra?raw";
import instagram from "./instagram-feed.yantra?raw";
import reddit from "./reddit-subreddit.yantra?raw";
import googleSearch from "./google-search.yantra?raw";
import amazon from "./amazon-product.yantra?raw";
import spotify from "./spotify-play.yantra?raw";
import stripe from "./stripe-charge.yantra?raw";
import uber from "./uber-matching.yantra?raw";
import irctc from "./irctc-tatkal.yantra?raw";

/** The system a brand-new visitor is dropped into: a cache shielding Postgres,
 * fragile on purpose (kill the cache and Postgres melts). Drives the first-run
 * activation flow. */
export const FIRST_RUN_EXAMPLE_RAW = cacheShield;

export interface ScenarioEntry {
  /** The `.yantra` document id, stable, so re-loading reloads the pristine demo. */
  id: string;
  title: string;
  blurb: string;
  /** The distinct behavior this demo is meant to reveal. */
  teaches: string;
  /** Which shelf it sits on: a combined-law showcase, a numbered lesson, or a
   * company architecture. */
  kind: "showcase" | "lesson" | "company";
  /** 1-based position in the curriculum (lessons only). */
  lesson?: number;
  /** The `.yantra` file text, passed verbatim to the importer. */
  raw: string;
}

export const SCENARIOS: readonly ScenarioEntry[] = [
  // ---- Lessons: the curriculum, one law at a time ----
  {
    id: "scn-cache-shield-0000-000000000002",
    title: "Lesson 1: Kill the Cache",
    blurb: "Redis shields a tiny Postgres from 90% of reads, until Redis dies at 5s and the miss trickle becomes a flood.",
    teaches: "Cache-death cascade: killing the cache drives h→0 and the shielded load lands on the store.",
    kind: "lesson",
    lesson: 1,
    raw: cacheShield,
  },
  {
    id: "scn-retry-storm-0000-000000000003",
    title: "Lesson 2: Retry Storm",
    blurb: "A tight 80ms timeout + 3 retries against a Postgres that is barely keeping up.",
    teaches: "Retry/timeout amplification: each retry multiplies offered load, the cascade fuel.",
    kind: "lesson",
    lesson: 2,
    raw: retryStorm,
  },
  {
    id: "scn-lesson-writes-000000000036",
    title: "Lesson 3: Reads vs Writes",
    blurb: "A PERFECT cache (h=1) in front of Postgres, yet the DB still runs at ρ≈0.5.",
    teaches: "Writes bypass caches: no hit ratio shields the write path. Crank the write ratio to prove it.",
    kind: "lesson",
    lesson: 3,
    raw: readsWrites,
  },
  {
    id: "scn-autoscale-flash-00000032",
    title: "Lesson 4: Flash Crowd Autoscaling",
    blurb: "5,200 req/s slams a one-instance API; the autoscaler grows the fleet ×1→×5.",
    teaches: "Autoscaling lags the spike: shed load first, capacity after the boot delay, then the bottleneck moves.",
    kind: "lesson",
    lesson: 4,
    raw: autoscaleFlash,
  },
  {
    id: "scn-lesson-replicas-00000037",
    title: "Lesson 5: Read Replicas & Stale Reads",
    blurb: "Postgres with 2 read replicas and a 20ms lag under a 5% write load.",
    teaches: "Reads route to replicas, writes stay on the primary, and ~⅓ of replica reads land inside the lag window: stale.",
    kind: "lesson",
    lesson: 5,
    raw: readReplicas,
  },
  {
    id: "scn-lesson-fanout-000000000038",
    title: "Lesson 6: Fan-out & the Critical Path",
    blurb: "One request fans out to MongoDB, Elasticsearch, and S3 in turn.",
    teaches: "Sequential fan-out sums the branches, see S3 dominate the waterfall. Then flip the API's Fan-out knob to parallel and watch latency collapse to the slowest branch.",
    kind: "lesson",
    lesson: 6,
    raw: fanout,
  },
  {
    id: "scn-lesson-fullstack-00000039",
    title: "Lesson 7: The Full Stack",
    blurb: "CDN → gateway → autoscaled API → Redis → replicated Postgres; the CDN dies at 5s.",
    teaches: "Everything at once: edge offload, the cascade, the autoscaler's rescue, and stale reads, one system.",
    kind: "lesson",
    lesson: 7,
    raw: fullStack,
  },
  {
    id: "scn-lesson-breaker-000000000043",
    title: "Lesson 8: Circuit Breakers Stop the Storm",
    blurb: "Lesson 2's exact retry storm, with a circuit breaker added on the Postgres dependency.",
    teaches: "The breaker trips OPEN instead of hammering the failing DB, rests it, then a half-open probe restores traffic, so throughput recovers in bursts where Lesson 2 stays pinned at zero.",
    kind: "lesson",
    lesson: 8,
    raw: circuitBreaker,
  },
  {
    id: "scn-lesson-async-000000000044",
    title: "Lesson 9: Async Messaging & Consumer Lag",
    blurb: "The broker primitive in isolation: a producer publishing 150 msg/s into Kafka drained by 4 consumers (~100 msg/s).",
    teaches: "Producing is decoupled from consuming: the producer's latency stays at the link cost while the consumer lag (backlog) climbs, because produce rate exceeds consume capacity.",
    kind: "lesson",
    lesson: 9,
    raw: asyncMessaging,
  },
  {
    id: "scn-lesson-sharding-000000045",
    title: "Lesson 10: Sharding Scales & Isolates",
    blurb: "An Elasticsearch split into 4 shards, each an independent cell; one shard is killed at 5s.",
    teaches: "Each shard is its own pool over its own key slice, so more shards raise the ceiling and a dead shard fails only its ~1/4 of requests, the rest keep serving.",
    kind: "lesson",
    lesson: 10,
    raw: sharding,
  },
  {
    id: "scn-lesson-quorum-0000000046",
    title: "Lesson 11: Quorum & Consistency",
    blurb: "A 6-node Cassandra ring at RF=3 with a WEAK quorum (W=1, R=1) under a 30% write load.",
    teaches: "Weak quorum trades consistency for speed: with W+R ≤ RF, ~2/3 of reads miss the latest write (stale). Raise W and R until W+R > RF and staleness vanishes.",
    kind: "lesson",
    lesson: 11,
    raw: quorum,
  },

  // ---- Companies: real architectures on their real stacks ----
  {
    id: "scn-netflix-0000-0000-000000000010",
    title: "Netflix: Stream Start",
    blurb: "Real scale: Netflix's edge serves ~2M req/s globally. This is ONE regional stream-start cell at 4,000 req/s: 95% Open-Connect CDN over a pre-provisioned autoscaled fleet (Chaos-Kong headroom) + EVCache, Cassandra, object store.",
    teaches: "The CDN dies at 4s and 20× lands on the origin, the ×5 headroom + EVCache swallow it whole; not one request fails. Trim Min instances to watch the autoscaler do it reactively instead.",
    kind: "company",
    raw: netflix,
  },
  {
    id: "scn-youtube-watch-000000000021",
    title: "YouTube: Watch Page",
    blurb: "Real scale: ~5B watches/day ≈ ~60K starts/s globally. This is one serving region at 5,000 req/s: a 95% CDN over a FIXED API fleet, Cassandra metadata, object storage (lognormal tail).",
    teaches: "The contrast to Netflix: no autoscaler, so the origin absorbs the CDN's death at ρ≈0.7, and users feel every ms.",
    kind: "company",
    raw: youtube,
  },
  {
    id: "scn-x-timeline-0000-000000000011",
    title: "X: Home Timeline",
    blurb: "Real scale: X's published numbers are ~300K QPS timeline reads vs ~6K tweets/s (≈2% writes). This is a 1% cell at 3,000 req/s: a hot Redis timeline cache over a masterless Cassandra tweet ring (6 nodes, RF=3, quorum W=R=2) + MySQL users with 2 read replicas.",
    teaches: "On a cache miss the tweet and user stores are hit in PARALLEL. Cassandra spreads writes over its ring (strong W+R>RF, so no stale tweets); the MySQL replicas run ~⅓ stale at a 10ms lag.",
    kind: "company",
    raw: xTimeline,
  },
  {
    id: "scn-instagram-feed-00000000022",
    title: "Instagram: Home Feed",
    blurb: "Real scale: feed loads run ~O(100K)/s globally. One region at 3,500 req/s on Instagram's famous trio: Redis feed cache, Cassandra media, Postgres with read replicas, over jittery mobile links.",
    teaches: "A replica-backed feed: parallel hydration on a miss, and the stale-read rate tracks the write rate live.",
    kind: "company",
    raw: instagram,
  },
  {
    id: "scn-reddit-sub-00000000000023",
    title: "Reddit: Subreddit Listing",
    blurb: "Real scale: Reddit serves ~3–8K QPS site-wide. This is a big-subreddit event at 3,000 req/s on Reddit's real pairing, Postgres shielded by memcached, running green at ρ≈0.35.",
    teaches: "The shield at production scale: h=0.9 keeps a modest pool at a third of capacity. Kill memcached yourself to reproduce Lesson 1 at 3,000 req/s.",
    kind: "company",
    raw: reddit,
  },
  {
    id: "scn-google-search-000000027",
    title: "Google: Query (cache → shards)",
    blurb: "Real scale: ~8.5B searches/day ≈ ~100K QPS globally, sharded over ~40 cells. This is ONE cell at 2,500 QPS: a query cache in front of a shard tier with a lognormal tail; the cache dies at 6s.",
    teaches: "Cache arithmetic at scale: shard load jumps ~3× on the kill, absorbed at ρ≈0.83, but the p99 screams first.",
    kind: "company",
    raw: googleSearch,
  },
  {
    id: "scn-amazon-product-000000025",
    title: "Amazon: Product Page & Cart",
    blurb: "Real scale: Prime-Day page traffic peaks ~O(50K)/s. One region at 3,000 req/s: a product page fanning out to Postgres, Cassandra recs, and Elasticsearch IN PARALLEL behind a Redis cache.",
    teaches: "Parallel fan-out: page latency tracks the slowest branch, not the sum; add-to-cart writes bypass the cache.",
    kind: "company",
    raw: amazon,
  },
  {
    id: "scn-spotify-play-0000000000024",
    title: "Spotify: Track Play",
    blurb: "Real scale: ~250M daily listeners ≈ ~60K play-starts/s peak. One playback region at 4,000/s: Cassandra metadata, then the audio object fetch (lognormal tail), inherently sequential.",
    teaches: "Latency accumulation: you cannot parallelize a dependency chain, the object fetch dominates the critical path.",
    kind: "company",
    raw: spotify,
  },
  {
    id: "scn-stripe-charge-000000029",
    title: "Stripe: Charge (write-heavy)",
    blurb: "Real scale: Stripe's published peak is ~13–20K API req/s TOTAL, this models the charge path at 1,000/s. Firewall → gateway → API; charges write MongoDB (Stripe's real store) + a fraud Lambda.",
    teaches: "Write path: 90% writes bypass the cache straight to the store, and fraud checks sit on the critical path.",
    kind: "company",
    raw: stripe,
  },
  {
    id: "scn-uber-matching-000000033",
    title: "Uber: Ride Matching",
    blurb: "Real scale: ~25M trips/day (~300/s global average), but matching is city-sharded. This is one mega-city at rush hour, 1,200 req/s: an autoscaled fleet over Redis geo, MySQL trips, Postgres riders.",
    teaches: "Rush hour on demand: raise the Client's request rate and watch the matching fleet grow to meet it.",
    kind: "company",
    raw: uber,
  },
  {
    id: "scn-irctc-tatkal-00000050",
    title: "IRCTC: Tatkal Booking (10 AM Rush)",
    blurb: "Real scale: IRCTC books ~13 lakh (1.3M) tickets/day, and at exactly 10:00 AM the Tatkal quota opens, drawing crores of hits at ~26K bookings/min peak. This is one route's quota: at t=4s the gate opens and load bursts ×8 for 8s. The app fleet AUTOSCALES to ride it, but the booking pool (the seat lock) is fixed. Set the timeline horizon to 30s to watch the whole arc.",
    teaches: "How IRCTC handles the rush: the stateless app tier scales up ×2→×8 to absorb the flood so nobody is turned away, but scaling the app does NOT create seats, the booking pool pins at its ceiling and the wait climbs to ~10s. When the burst ends at 12s the fleet scales back down (after the autoscaler's anti-flap delay) and the seat backlog slowly drains. Watch the app fleet ramp up and down around a bottleneck that can't.",
    kind: "company",
    raw: irctc,
  },

  // ---- Showcases: laws combined on purpose, allowed to stress ----
  {
    id: "scn-showcase-shared-db-000040",
    title: "Shared Database: One Pool, Two Services",
    blurb: "orders-api and inventory-api are independent services that happen to share one Postgres. Orders bursts ×8; Inventory's traffic never changes.",
    teaches: "Shared-resource contention: Orders' burst fills the common connection pool, so Inventory's latency spikes even though its own load is flat, then both recover.",
    kind: "showcase",
    raw: sharedDb,
  },
  {
    id: "scn-showcase-kafka-00000041",
    title: "Kafka: Decoupling & Backlog",
    blurb: "A producer publishes to Kafka, drained by 6 consumers (~200 msg/s). A ×5 burst produces far past that for 3s.",
    teaches: "Async decoupling: the producer's latency stays flat while the consumer backlog (lag) climbs, then the consumers drain it once the burst passes.",
    kind: "showcase",
    raw: kafkaBacklog,
  },
  {
    id: "scn-showcase-cascade-0000042",
    title: "Cascade & Rewind",
    blurb: "A cache-shielded API (autoscaled, retries + circuit breaker) loses Redis at 4s, everything engages at once, then Redis heals at 7s.",
    teaches: "A live cascade and its recovery: the cache death floods Postgres, retries amplify, the breaker trips, the fleet scales, and the system recovers on heal. Branch the timeline at 4s to compare 'heal' vs 'never heal'.",
    kind: "showcase",
    raw: cascadeRewind,
  },
  {
    id: "scn-showcase-ecommerce-047",
    title: "E-Commerce Platform: Black Friday",
    blurb: "A full retail stack (12 component types): Browser → CDN → gateway → LB → two autoscaled APIs fanning out in parallel to a Redis cart cache, a quorum Cassandra catalog, a sharded Elasticsearch, replicated Postgres orders, and a Kafka order bus feeding fulfillment workers + a MySQL warehouse. A ×5 flash-sale burst hits, and the CDN dies at 4s.",
    teaches: "Everything at once under peak: the CDN death floods the origin, the API fleet autoscales ×1→×3 (shedding briefly), the order-event backlog climbs into the thousands then drains, and the whole system claws back to green by the time the CDN heals.",
    kind: "showcase",
    raw: ecommerce,
  },
  {
    id: "scn-showcase-social-048",
    title: "Social Network: Viral Post",
    blurb: "A social feed (11 component types): Browser → CloudFront → gateway → LB → autoscaled APIs (keep-alive connections, breaker) fanning to a Redis feed cache, quorum Cassandra posts, MySQL user replicas, a Lambda moderation check, and a NATS pub/sub bus fanning to timeline workers. Traffic ramps as a post goes viral; the feed cache dies at 5s.",
    teaches: "A viral ramp with a resilient core: the fleet autoscales into the surge, and when the feed cache dies the quorum store and replicas absorb the full read load with zero failures until it heals.",
    kind: "showcase",
    raw: social,
  },
  {
    id: "scn-showcase-streaming-049",
    title: "Streaming Platform: Global Launch",
    blurb: "A media platform (15 component types, the widest system here): Browser + a Cron cleanup job → DNS → CDN → firewall → gateway → LB → an autoscaled API (CPU contention, keep-alive) fanning to memcached, a 5-shard Elasticsearch, quorum Cassandra metadata, S3 media, and an SQS transcode queue feeding a worker pool, plus a Lambda. A launch ramp climbs, and one search shard is killed at 7s.",
    teaches: "The full catalog in one graph: a launch ramp with a transcode pipeline, and a single dead shard fails only its own key slice (the other four keep serving) until it is restarted.",
    kind: "showcase",
    raw: streaming,
  },
  {
    id: "scn-showcase-frankenstein-051",
    title: "Frankenstein: The Whole Catalog",
    blurb: "Every one of the 29 component types stitched into one over-built system: web and mobile front doors (CloudFront/CDN over a full DNS → firewall → router → switch → reverse-proxy → API gateway → ingress → load-balancer chain), an autoscaled parallel-fan-out API hitting Redis+Memcached (backed by Postgres/Mongo), MySQL, a quorum Cassandra ring, a 5-shard Elasticsearch, S3, and a Lambda, plus five message buses (Kafka, SQS, NATS, RabbitMQ, Queue) feeding worker pools. Traffic ramps to ~1,500 req/s.",
    teaches: "Spared no expense: a deliberately monstrous architecture that still runs green. Every tier sits at low utilization because it is generously provisioned, so nothing fails under sustained load, the point is to see the whole catalog behave at once, then break any single piece yourself and watch the rest carry it.",
    kind: "showcase",
    raw: frankenstein,
  },
];

/** Combined-law showcases, allowed to show real stress. POLICY: unlike Companies,
 * a showcase MAY degrade (a growing backlog, a starved pool, a tripped breaker),
 * because recovering from it is the lesson, but it must still finish SERVING
 * requests (completions > 0, enforced by test). They sit LAST, after Companies. */
export const SHOWCASES: readonly ScenarioEntry[] = SCENARIOS.filter(
  (s) => s.kind === "showcase",
);

/** The numbered curriculum, in teaching order. */
export const LESSONS: readonly ScenarioEntry[] = SCENARIOS.filter(
  (s) => s.kind === "lesson",
);

/** Real-company architectures, the engine at full stretch. POLICY: company
 * scenarios ship GREEN, they always deliver their stated scale with zero
 * failures (enforced by test). Breaking things is the Lessons' job, or one
 * click away in Failure injection. */
export const COMPANIES: readonly ScenarioEntry[] = SCENARIOS.filter(
  (s) => s.kind === "company",
);

export {
  GUIDE_INTRO,
  SHOWCASES_GUIDE,
  LESSONS_GUIDE,
  COMPANIES_GUIDE,
  SCENARIO_NOTES,
  type GuideSection,
  type ScenarioNotes,
} from "./guide";
