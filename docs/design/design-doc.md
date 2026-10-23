# S3 Storage Browser & Maintenance Tool: Design Doc

Oct 22, 2026 · @Aaron Tawil

## 1. Overview, goals, non-goals

Build a web app that browses and maintains S3 buckets by running SQL in DuckDB over an index of every object, so folder navigation, search, and cleanup analysis return in milliseconds instead of paginated `ListObjectsV2` calls.

**Problem.** `ListObjectsV2` returns 1,000 keys per call, cannot filter by size, age, or storage class, and bills per request. Consoles stall on large prefixes. Maintenance questions (what is stale, duplicated, or wasting money) need full scans that nobody runs.

**Goals**

- Instant browse and search over buckets with 100M+ objects, served from a local index, on any S3-compatible store (Pure Storage FlashBlade included).
- Ad hoc SQL over the index, plus in-place preview of Parquet, CSV, and JSON objects.
- Analyzers that find hygiene and space problems and show how much space each cleanup would reclaim.
- Actions that are dry-run first, approved, audited, and reversible where S3 allows.
- Simple deployment: one container, one DuckDB file per workspace, no external database.

**Non-goals (v1)**

- Not a sync, backup, or replication tool.
- Not a replacement for the store's own monitoring. It can consume S3 Inventory where the store provides it.
- No object content editing.
- No multi-cloud, but keep an `ObjectStore` interface so GCS or Azure can be added later.
- No sub-minute index freshness guarantee; every screen shows index age.

## 2. Users and key workflows

Three users share one tool: data and platform engineers (browse, preview, SQL), FinOps (cost findings), and security or compliance (posture reports).

1. **Connect a bucket.** Enter an endpoint and access keys, let the tool check what the store supports, pick a bucket, and start the first index run.
2. **Browse and search.** Navigate folders with sizes, filter by size, age, class, or extension, open an object, download via presigned URL.
3. **Preview data.** Click a Parquet, CSV, or JSON file to see schema, row count, and the first 100 rows without downloading it.
4. **Investigate in SQL.** Open the console on the index, save queries, export results.
5. **Find cleanup work.** Run analyzers, review findings ranked by how much space they would reclaim.
6. **Act safely.** Turn selected findings into an action plan, dry-run it, approve it, execute it, and review the audit trail.
7. **Automate.** Schedule index refreshes and analyzer runs; get a notification when new findings exceed a reclaimable-space threshold.

## 3. Architecture and tech stack

&#91;embedded content: architecture · 1 API process, 4 AWS parts\]

The web UI talks only to the API process. That process owns the DuckDB file and runs the indexer, analyzers, and executor as in-process workers. DuckDB reads Inventory output and preview files from S3 directly through `httpfs`, and the executor runs large plans in bounded batches.

| Layer | Default choice |
| --- | --- |
| Backend | Python 3.12, FastAPI, DuckDB, boto3 |
| Frontend | React, TypeScript, Vite, TanStack Query and Table, Monaco |
| Jobs | In-process thread pool with a persisted job table; no external queue |
| Packaging | One container image, one volume for the `.duckdb` file |
| Interfaces | `ObjectStore` abstraction over S3 so other stores can be added later |

The repository layout is in section 11.

## 4. How DuckDB is used

DuckDB is the index store, the loader, the analytical engine, and the in-place file reader. Every browse, search, and analyzer result is a SQL query; the API layer only builds, parameterizes, and paginates them. Pin a current stable DuckDB release (1.3 or later) and enable the `httpfs`, `aws`, `parquet`, `json`, and `iceberg` extensions.

**Four roles**

| Role | Mechanism |
| --- | --- |
| Index store | One `.duckdb` file per workspace holding `objects`, `prefix_stats`, findings, plans, audit. |
| Index loader | Crawl batches written to local Parquet, then bulk-loaded. Where the store offers S3 Inventory, `read_parquet('s3://<inv-bucket>/<path>/data/*.parquet')` reads it straight from S3. |
| Analytical engine | Browse, search, rollups, and all analyzers are SQL files run against the index. |
| File reader | `read_parquet`, `read_csv`, `read_json` over `s3://` for previews, using a per-connection S3 secret; `iceberg_scan` and `iceberg_snapshots` for Iceberg-aware analyzers. |

**Connections and capabilities**

- **A connection** holds an endpoint URL, a region (any value if the store ignores it), an access key and secret (or the AWS credential chain), an addressing style (path or virtual-hosted), TLS settings (custom CA bundle; verification can be turned off per connection, with a warning), and a provider hint (AWS, Pure Storage FlashBlade, MinIO, Ceph, other). Several stores can be connected at once.
- **Per connection**, create a DuckDB secret scoped to its buckets, for example `CREATE SECRET ... (TYPE S3, KEY_ID, SECRET, ENDPOINT, URL_STYLE, USE_SSL, REGION, SCOPE)`, and build a boto3 client with the same settings for live calls.
- **Capability probe.** On connect, test list objects, list versions and versioning state, list multipart uploads, object tagging, lifecycle configuration, Object Lock, presigned URLs, additional checksums, and S3 Inventory. Store the result in `buckets.capabilities` and show Supported, Not supported, or Not tested in Settings.
- **Features follow capabilities.** Every feature checks its capability and hides or explains itself when it is missing. The provider hint only sets defaults and never replaces the probe. Fields that only some stores report (`storage_class`, encryption, replication) are nullable.
- **Pure Storage FlashBlade.** Pure's S3 documentation lists versioning and Object Lock among supported features. Treat everything else as probed. Expect a private endpoint, and possibly path-style addressing and an internal CA. Start in Crawl mode.

**Two index modes**

- **Crawl mode (default).** Shard the key space by prefix (delimiter listing to depth 2 to 3), list shards in parallel with `ListObjectsV2` (and `ListObjectVersions` when versioning is on), write each batch to a local Parquet file, then bulk-load. Works on every S3-compatible store. Show the estimated number of list requests before starting, and honor a per-connection request-rate cap so indexing never competes with production traffic.
- **Inventory mode (optional).** Where the store provides S3 Inventory (AWS does), read the latest `manifest.json` and load its Parquet files. Complete and cheap on very large buckets, but 24 to 48 hours stale. Only offered when the capability probe finds it.
- **Later (v2):** bucket event notifications, where the store supports them, for incremental upserts.

**Ingest pattern: stage, validate, swap**

1. Load into `objects_stage_<run_id>`, sorted by `(bucket, key)` so zone maps make prefix scans fast. Set `preserve_insertion_order=false` during load.
2. Validate: row count and total bytes within tolerance of the manifest, no null keys.
3. In one transaction, delete the bucket's old rows, insert from stage, rebuild that bucket's `prefix_stats`, write `index_runs`. Readers never see a half-loaded index.

**Concurrency rules (DuckDB allows one read-write process per file)**

- One API process owns the file. Use `con.cursor()` per request for reads; route all writes (ingest, findings, audit) through a single writer queue.
- Set `memory_limit`, `threads`, and `temp_directory` from config. Give interactive queries a timeout via `interrupt()`; cap rows returned (default 100k).
- Ingest and analyzers run in a worker thread in the same process, never a second process on the same file.

**SQL console hardening**

- Allow only statements whose parsed type is `SELECT`, plus `DESCRIBE`, `EXPLAIN`, and `SUMMARIZE`. Parse with `duckdb.extract_statements()`; reject everything else, including `COPY`, `ATTACH`, `INSTALL`, `LOAD`, `SET`, and `PRAGMA`.
- Restrict local file access with `allowed_directories` (or `enable_external_access` with an allow-list) so `read_csv('/etc/passwd')` fails. Verify the setting names against the pinned DuckDB version.
- Console exports (`COPY ... TO`) go through a dedicated export endpoint, not free-form SQL.

## 5. Data model

The `objects` table is the heart of the system; everything else is small. Derived columns are computed once at ingest so browse queries are equality lookups, not string parsing.

```sql
CREATE TABLE objects (
  bucket            VARCHAR NOT NULL,
  key               VARCHAR NOT NULL,
  version_id        VARCHAR,            -- NULL if unversioned
  is_latest         BOOLEAN NOT NULL,
  is_delete_marker  BOOLEAN NOT NULL,
  size              BIGINT,
  last_modified     TIMESTAMP,
  etag              VARCHAR,
  storage_class     VARCHAR,
  is_multipart      BOOLEAN,
  checksum_algo     VARCHAR,
  encryption        VARCHAR,            -- SSE-S3 | SSE-KMS | NONE
  replication       VARCHAR,
  it_access_tier    VARCHAR,            -- Intelligent-Tiering tier
  object_lock_mode  VARCHAR,
  -- derived at ingest
  parent_prefix     VARCHAR NOT NULL,   -- 'a/b/' for key 'a/b/c.parquet'; '' at root
  name              VARCHAR NOT NULL,   -- 'c.parquet'
  ext               VARCHAR,            -- 'parquet' (lower-case, last segment)
  depth             SMALLINT NOT NULL,  -- number of '/' in parent_prefix
  run_id            VARCHAR NOT NULL
);
-- always insert ORDER BY bucket, key (zone maps accelerate prefix scans)
```

**If the store offers S3 Inventory, enable these fields:** Size, LastModifiedDate, ETag, StorageClass, IsMultipartUploaded, ReplicationStatus, EncryptionStatus, IsLatest, IsDeleteMarker, ChecksumAlgorithm, IntelligentTieringAccessTier, ObjectLockMode. Output format Parquet. Version IDs require a versioned inventory ("include all versions").

**Supporting tables**

| Table | Purpose | Key columns |
| --- | --- | --- |
| `buckets` | Registered buckets and their connection | bucket, endpoint, url\_style, secret\_ref, provider\_hint, index\_mode, capabilities (JSON), write\_enabled, last\_indexed\_at |
| `index_runs` | One row per ingest | run\_id, bucket, mode, source\_manifest, started\_at, finished\_at, status, rows, bytes, error |
| `prefix_stats` | Rollup per folder, powers tree sizes and treemap | bucket, prefix, parent\_prefix, depth, objects, bytes, oldest, newest |
| `multipart_uploads` | Live-fetched incomplete uploads | bucket, key, upload\_id, initiated, parts\_bytes |
| `lifecycle_rules` | Cached bucket lifecycle config, parsed (only where the store supports it) | bucket, rule\_id, prefix, tags, min\_size, actions (JSON) |
| `iceberg_tables`, `iceberg_files` | Detected Iceberg tables and the files each snapshot references | bucket, location, latest\_metadata, format\_version; table, snapshot, path, size, kind |
| `findings` | Analyzer output | finding\_id, run\_id, analyzer, bucket, prefix, severity, reclaimable\_bytes, details (JSON), status (open, ignored, planned, resolved) |
| `action_plans` | A reviewable batch of changes | plan\_id, created\_by, action\_type, params (JSON), status (draft, dry\_run, approved, running, done, failed, cancelled), counts |
| `action_plan_items` | One row per object touched | plan\_id, bucket, key, version\_id, expected\_etag, expected\_last\_modified, status, error, executed\_at |
| `audit_log` | Append-only record of every write | ts, actor, action, bucket, params (JSON), result |
| `saved_queries`, `settings`, `metrics_daily` | Console, config, trend charts |  |

**`prefix_stats` build:** at ingest, emit one row per object per ancestor prefix (unnest the prefix chain), then `GROUP BY (bucket, prefix)`. Only latest, non-delete-marker objects count toward `objects` and `bytes`; track noncurrent bytes in separate columns.

**Folder listing is two cheap queries:**

```sql
-- folders: from the rollup
SELECT prefix, objects, bytes, newest FROM prefix_stats
WHERE bucket = $b AND parent_prefix = $prefix ORDER BY prefix;
-- files: keyset pagination on key
SELECT name, size, last_modified, storage_class FROM objects
WHERE bucket = $b AND parent_prefix = $prefix AND is_latest AND NOT is_delete_marker
  AND key > $cursor ORDER BY key LIMIT 500;
```

## 6. Browser features

All browse features read the index; only object detail, preview, and downloads touch S3 live.

- **Bucket switcher** with an index-age badge ("indexed 6h ago, inventory mode") and a **Refresh prefix** action that live-crawls one prefix and upserts it.
- **Folder tree and table.** Lazy tree with object counts and bytes from `prefix_stats`; breadcrumb; sortable, virtualized table; keyset pagination; configurable columns.
- **Search and filters.** Name substring, glob, or regex (`ILIKE`, `regexp_matches`); size range; modified range; storage class; extension; version state (current, noncurrent, delete markers). Every filter set compiles to SQL, shown under **Show SQL** with **Open in console**.
- **Object detail drawer.** Index metadata plus a live `HeadObject` (authoritative), version list, tags, copy S3 URI, presigned download URL (default 5 minute TTL).
- **Data file preview.** For Parquet, CSV, JSON, JSONL, and gzip variants: schema, row count (Parquet footer), first 100 rows via `read_parquet` or `read_csv` with `LIMIT`. Refuse files above a configurable size for non-Parquet formats. If a prefix contains `metadata/*.metadata.json`, offer an Iceberg table view (snapshots, partition spec, file counts).
- **Explore.** Treemap of bytes by prefix, size histogram, modified-date timeline, storage-class breakdown, all from `prefix_stats` and `objects`.
- **SQL console.** Monaco editor with schema-aware autocomplete, result grid, cancel, history, saved queries, CSV or Parquet export. Applies the hardening rules in section 4.
- **Basic operations**, all routed through the plan and audit engine (section 7): delete, tag, restore archived objects (where the store supports it), copy or move, set storage class. v1 may ship delete, tag, and restore only.

**Behavior rules**

- If the index is older than a configurable threshold (default 48h), show a warning on every listing.
- A hit from the index that no longer exists in S3 (404 on `HeadObject`) is flagged in the drawer and queued for a prefix refresh.

## 7. Maintenance: analyzers and actions

Maintenance is a pipeline: **analyzers** (read-only SQL) produce **findings**; findings become **action plans**; plans are dry-run, approved, and executed under guardrails.

### Analyzer contract

Each analyzer is a folder with a `manifest.yaml` (id, title, parameter schema with defaults, severity rules), a `find.sql` that returns finding rows, and optional `actions.yaml` mapping findings to supported actions. Adding an analyzer must require no application code change. Each finding reports the bytes it would reclaim.

### v1 analyzers

| Analyzer | Finds | Core logic | Suggested action |
| --- | --- | --- | --- |
| Top consumers | Largest prefixes and objects | `prefix_stats` and `ORDER BY size DESC` | Report only |
| Old data | Prefixes with no writes in N days (default 180) | `max(last_modified) < now() - N` per prefix | Review, then delete, or add an expiry rule where lifecycle is supported |
| Noncurrent versions and delete markers | Version buildup, expired delete markers | `NOT is_latest` grouped by prefix, age | Noncurrent-version expiry rule where supported, otherwise batch delete |
| Incomplete multipart uploads | Orphaned upload parts | Live `ListMultipartUploads`, stored in `multipart_uploads` | Abort, plus an abort-incomplete-uploads rule where supported |
| Duplicates | Same size and ETag across keys | Group by `(size, etag)` where not `is_multipart`; multipart ETags are unreliable, so flag as "possible" and offer checksum verification | Review, then delete extras |
| Small files | Prefixes with many objects and low median size | `count(*) > N AND median(size) < 16 MB` | Report with compaction advice |
| Lifecycle coverage (where supported) | Bytes not covered by any lifecycle rule | Evaluate cached `lifecycle_rules` (prefix, tag, size filters) against the index | Draft rule |
| Zero-byte and placeholders | Empty objects, keys ending in `/` | `size = 0` | Delete (review) |
| Key hygiene | Leading or trailing whitespace, `//`, control characters, case-only collisions, very long keys | Regex and `lower(key)` self-join | Report |
| Posture (where the store reports it) | Unencrypted objects, failed replication, no Object Lock where policy expects it | `HeadObject` or inventory fields | Report only |

### Iceberg support (v1: discovery and health; v2: cleanup)

The same index serves Iceberg tables, in two layers that are joined in SQL.

- **Storage layer (the index).** Every data, delete, manifest, and metadata file is an ordinary object. A prefix containing `metadata/*.metadata.json` is registered in `iceberg_tables` (bucket, location, latest metadata file, format version).
- **Table layer (read from metadata, cached).** DuckDB's `iceberg` extension (`iceberg_metadata`, `iceberg_snapshots`, `iceberg_scan`) returns snapshots, schema, partition spec, and the data and delete files each snapshot references. Store them in `iceberg_files` (table, snapshot, path, size, kind).
- **Reconciliation.** A semi-join of `iceberg_files` to `objects` attributes bytes to tables; an anti-join of `objects` under a table location to `iceberg_files` yields orphan candidates.

**v1 features:** a **Tables** view (browse by table, not by key); table detail with snapshot timeline, schema, partitions, file-size histogram, and bytes split into live data, delete files, metadata, and unreferenced; time-travel preview via `iceberg_scan`; health analyzers for small data files, snapshot and metadata bloat, delete-file buildup, and orphan candidates (report only).

**Actions stay on the engine.** Findings generate ready-to-run statements for the table's own engine (compaction, `expire_snapshots`, `remove_orphan_files`) that the user copies or runs elsewhere. The tool never deletes files under an Iceberg table location in v1.

**Caveats:** tables whose metadata is held by a REST, Glue, or Hive catalog need the current metadata location (supplied per table in v1; resolved through the catalog API in v2). Verify delete-file and format-version support against the pinned DuckDB release.

### v2 additions (Iceberg cleanup, Hive)

- **Orphan file candidates.** Anti-join objects under an Iceberg table location against files referenced by all snapshots and metadata (via `iceberg_*` functions). Exclude anything newer than a safety window (default 72h).
- **Metadata and snapshot bloat**, **small data files per partition**, **empty or skewed Hive partitions**.
- Iceberg-managed data is never raw-deleted by default. The action is a recommendation to run the engine's own `expire_snapshots` and `remove_orphan_files` procedures; direct deletion requires an explicit override and the orphan safety window.

### Action engine

1. **Create plan** from selected findings or a console result set. Items are materialized in `action_plan_items` with the `etag` and `last_modified` the index saw.
2. **Dry run (mandatory).** Report object count, bytes, a sample, and the number of S3 requests needed. No S3 write calls.
3. **Approve.** Typed confirmation (bucket name) for any delete or more than N objects (configurable). Two-person approval is a v2 option.
4. **Execute.** The executor runs in-process: `DeleteObjects` in batches of 1,000, bounded concurrency, a per-connection request-rate cap, and exponential backoff. Execution is idempotent and resumable with per-item status.
5. **Audit.** Every execution step is appended to `audit_log`.

### Safety guardrails (non-negotiable)

- **Read-only by default.** Write operations are off per bucket until an admin enables `write_enabled`, and use a separate IAM role (section 10).
- **Stale-index guard.** Before acting on an item, re-`HeadObject`; skip and report if `etag` or `last_modified` differs from the plan.
- **Protected prefixes** (configurable deny list) can never be targeted.
- **Object Lock and legal hold** are respected; items that fail are reported, never retried with bypass.
- **Versioned buckets:** a delete creates a delete marker. Record marker and version ids so **Undo** can remove them.
- **Plan size cap** (default 1M objects) and a global kill switch.
- Copies and moves record source and destination so they can be reversed.

### Scheduling and reports

Cron-style schedules for index refresh and analyzer runs. `metrics_daily` stores bytes and objects by class for trend charts. Reports export to CSV, Parquet, or HTML. A webhook (Slack or email) fires when new findings exceed a reclaimable-space threshold.

## 8. API surface

REST and JSON under `/api`, with an OpenAPI spec generated from the code. Long-running work returns a job id; progress streams over Server-Sent Events. Errors use RFC 7807 problem details. Every endpoint that writes requires the bucket's `write_enabled` flag and an authenticated actor.

| Method and path | Purpose |
| --- | --- |
| `GET /buckets`, `POST /buckets`, `GET /buckets/{b}` | List, register, and inspect buckets (includes index age and mode) |
| `POST /buckets/{b}/index` | Start an index run: `{mode, prefix?}` returns a job |
| `GET /jobs/{id}`, `GET /jobs/{id}/events` | Job status and SSE progress |
| `GET /buckets/{b}/browse` | `prefix`, `cursor`, `sort`, `filters`: folders and files for one level |
| `GET /buckets/{b}/tree` | Child folders with counts and bytes for lazy tree expansion |
| `GET /buckets/{b}/search` | Filter and search across the whole bucket, keyset paginated |
| `GET /buckets/{b}/objects/{key}` | Live `HeadObject`, tags, versions |
| `GET /buckets/{b}/objects/{key}/download-url` | Short-lived presigned URL |
| `GET /buckets/{b}/objects/{key}/preview` | Schema, row count, first rows for supported formats |
| `POST /query` | `{sql, params, limit}` returns columns and rows (JSON; Arrow IPC via `Accept` header) |
| `POST /export` | Run a validated query and write CSV or Parquet to a download or an S3 target |
| `GET`, `POST`, `DELETE /saved-queries` | Console library |
| `GET /analyzers`, `POST /analyzers/{id}/run` | Discover and run analyzers (returns a job) |
| `GET /findings`, `PATCH /findings/{id}` | List findings; set status (ignored, etc.) |
| `POST /plans` | Create a plan from `{finding_ids}` or `{query}` |
| `GET /plans/{id}`, `POST /plans/{id}/dry-run`, `/approve`, `/execute`, `/cancel`, `/undo` | Plan lifecycle |
| `GET /audit` | Filterable audit log, exportable |
| `GET /health`, `GET /metrics` | Liveness and Prometheus metrics |

**Conventions**

- Keys are passed as URL-encoded path segments or, for safety with odd characters, in a `?key=` query parameter; both must work.
- All SQL uses bound parameters. The only dynamic SQL is the console, which goes through the validator in section 4.
- The plan lifecycle is a state machine; invalid transitions return `409`.

## 9. UI design

Seven screens behind a left nav: **Browse, Tables, Query, Maintenance, Plans, Jobs, Settings**. Dense and keyboard-friendly, with light and dark themes.

| Screen | Layout and key behavior |
| --- | --- |
| Browse | Left: lazy folder tree. Center: breadcrumb, filter bar, virtualized table with size, modified, class. Right: object drawer (metadata, versions, preview tab, actions). Header shows bucket, index age, **Refresh prefix**. |
| Query | Monaco editor with schema sidebar; results grid below; history and saved queries; **Export** and **Cancel**. |
| Maintenance | KPI row (total bytes, objects, reclaimable space, open findings), trend chart from `metrics_daily`, findings table ranked by reclaimable space with **Create plan** on selected rows. Treemap tab. |
| Plans | List by status. Plan detail shows scope, sample items, cost estimate, dry-run result, approval control, live progress, per-item errors, **Undo** when available. |
| Jobs | Index runs, analyzer runs, executions with streaming logs. |
| Settings | Connections (endpoint, keys, TLS), capability probe results, indexing mode, protected prefixes, thresholds, schedules, webhooks, write-mode toggles. |

**Tables** lists the Iceberg tables found in the bucket; opening one shows snapshots, file sizes, and health checks (section 7). **Settings** holds connections: endpoint, keys, addressing style, TLS, and the capability probe result for each store.

**Principles**

- Show what the system knows and how old it is: index age on every listing, "Show SQL" on every filter.
- Destructive controls look different (critical color, typed confirmation) and are never reachable from a single click on a list row.
- Prefer labeled controls over icon-only controls; keep each screen to one primary action.
- Accessible by default: keyboard navigation in the tree and table, visible focus, no color-only status.
- Empty states explain the next step (for example, "Start the first index run").

## 10. Security, performance, observability

### Security

- **Credentials.** Each connection uses its own access key and secret, supplied through the app's secret store (environment, mounted file, or a vault) and never written to the DuckDB file. On AWS, the default credential chain or STS `AssumeRole` also works.
- **Two credentials per connection.** The **reader** credential is used by indexing, browse, preview, and analyzers. The **writer** credential is used only by the executor and only when `write_enabled` is on. Grant them through the store's own access-policy mechanism.

| Credential | Permissions |
| --- | --- |
| Reader | `s3:ListBucket`, `s3:ListBucketVersions`, `s3:ListBucketMultipartUploads`, `s3:GetObject`, `s3:GetObjectVersion`, `s3:GetObjectTagging`, `s3:GetBucketLocation`, `s3:GetBucketVersioning`, `s3:GetLifecycleConfiguration` (where supported), read on the inventory bucket if used |
| Writer | `s3:DeleteObject`, `s3:DeleteObjectVersion`, `s3:PutObjectTagging`, `s3:AbortMultipartUpload`, `s3:PutObject` (copy and move), `s3:RestoreObject` and `s3:PutLifecycleConfiguration` (where supported) |

- **App auth.** OIDC login with roles (viewer, operator, admin). Viewers cannot create plans; only admins toggle `write_enabled`. A local single-user token mode is allowed for dev.
- **Data handling.** Persist no object contents. Preview rows are never logged. Presigned URLs are short-lived. Keep secrets out of the DuckDB file; optionally encrypt the file (`ENCRYPTION_KEY` on attach, where the pinned version supports it).
- **Input safety.** Bound SQL parameters everywhere; console validator per section 4; strict output encoding for object keys in the UI (keys can contain anything).

### Performance targets (validate with benchmarks in M1)

| Operation | Target at 100M objects |
| --- | --- |
| Browse one folder level (500 rows) | p95 under 200 ms |
| Expand a tree node | p95 under 100 ms |
| Filtered global search | p95 under 2 s |
| Inventory ingest | at least 500k rows/s on 8 vCPU |
| Crawl listing | at least 20k keys/s with sharded parallel listing |
| Index size on disk | roughly 40 to 80 bytes per object (estimate; measure and record) |

Techniques: sorted inserts, derived columns, `prefix_stats` rollups, keyset pagination, bounded `memory_limit`, spill to `temp_directory`.

### Request load

Cap list and head request rates per connection (configurable) so indexing never competes with production workloads on a shared store. Show the estimated number of list requests before any crawl or live action.

### Observability

Structured JSON logs with request and job ids; Prometheus metrics (query latency by endpoint, index age per bucket, ingest rows and duration, S3 request counts, plan execution outcomes); optional OpenTelemetry traces.

## 11. Milestones, acceptance, build notes

Milestones run in order, and each v1 milestone closes on a gate that must pass before the next starts. M5 is v2 and not gated.

&#91;embedded content: roadmap · 5 milestones, 4 gates\]

The gates restate the matching acceptance criteria below.

### Acceptance criteria (v1)

- A Crawl-mode index of a test bucket matches a direct listing in row count and bytes, and an Inventory-mode load of a 100M-row Parquet inventory matches its manifest.
- The performance targets in section 10 are met on a synthetic 100M-object index.
- The console rejects every non-SELECT statement and every local-file read in the test suite.
- Each v1 analyzer has a fixture dataset with expected findings, and reclaimable-space figures match hand-computed values.
- A plan cannot execute without a dry run and an approval. Tests for the stale-index guard, protected prefixes, and Object Lock pass.
- Undo restores objects deleted from a versioned bucket.
- The audit log records actor, parameters, and result for every executed batch.

### Build notes for the implementing agent

- **Default stack:** Python 3.12, FastAPI, DuckDB, boto3, a thread-pool job runner; React, TypeScript, Vite, TanStack Query and Table (virtualized), Monaco. One container image.
- **Build order:** follow the milestones, but write the synthetic inventory generator first (Parquet with realistic key shapes, versions, storage classes, duplicates, orphan-like files). Benchmarks and analyzer fixtures depend on it.
- **Testing:** unit tests with moto; integration tests against MinIO (no S3 Inventory) and LocalStack, with the capability probe run against each. Features a test store lacks need mocks.
- **Isolation:** all DuckDB access lives in one module (`duck.py`) so version-specific settings and the writer queue are in one place.
- **SQL hygiene:** every SQL file is parameterized and has a test that runs it against a small fixture.

```
/api              FastAPI app, routers, auth
/core
  duck.py         connection owner, writer queue, settings
  index/          inventory loader, crawler, stage-validate-swap, prefix_stats
  store/          ObjectStore interface + S3 implementation
  query/          console validator, parameterized browse and search builders
  analyzers/      one folder each: manifest.yaml, find.sql, actions.yaml
  actions/        plan engine, executor, guardrails, undo
/web              React app
/tests            unit, integration, fixtures, synthetic inventory generator
```

### Open questions

- Backend language: Python (assumed above) or .NET with DuckDB.NET?
- Deployment and auth: single-tenant internal tool behind OIDC, or multi-tenant?
- Which features does your FlashBlade array have enabled: versioning, lifecycle rules, Object Lock? The capability probe reports this, but knowing up front sets v1 scope.
- Ship write mode in v1, or read-only first?
- Can the tool read the Iceberg catalog or metadata locations needed for the v2 analyzers?
