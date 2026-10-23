CREATE TABLE IF NOT EXISTS connections (
  connection_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  endpoint VARCHAR NOT NULL,
  region VARCHAR NOT NULL,
  url_style VARCHAR NOT NULL,
  use_ssl BOOLEAN NOT NULL,
  tls_verify BOOLEAN NOT NULL,
  ca_bundle_path VARCHAR,
  provider_hint VARCHAR NOT NULL,
  reader_secret_ref VARCHAR NOT NULL,
  writer_secret_ref VARCHAR,
  request_rate_per_sec INTEGER,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS buckets (
  bucket VARCHAR PRIMARY KEY,
  connection_id VARCHAR NOT NULL,
  index_mode VARCHAR NOT NULL DEFAULT 'crawl',
  inventory_uri VARCHAR,
  capabilities VARCHAR,
  write_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  protected_prefixes VARCHAR,
  stale_after_hours INTEGER NOT NULL DEFAULT 48,
  plan_confirm_min_objects INTEGER NOT NULL DEFAULT 100,
  plan_size_cap INTEGER NOT NULL DEFAULT 1000000,
  last_indexed_at TIMESTAMP,
  last_run_id VARCHAR
);

CREATE TABLE IF NOT EXISTS objects (
  bucket VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  version_id VARCHAR,
  is_latest BOOLEAN NOT NULL,
  is_delete_marker BOOLEAN NOT NULL,
  size BIGINT,
  last_modified TIMESTAMP,
  etag VARCHAR,
  storage_class VARCHAR,
  is_multipart BOOLEAN,
  checksum_algo VARCHAR,
  encryption VARCHAR,
  replication VARCHAR,
  it_access_tier VARCHAR,
  object_lock_mode VARCHAR,
  parent_prefix VARCHAR NOT NULL,
  name VARCHAR NOT NULL,
  ext VARCHAR,
  depth SMALLINT NOT NULL,
  run_id VARCHAR NOT NULL
);

CREATE INDEX IF NOT EXISTS objects_by_prefix ON objects (bucket, parent_prefix, key);

CREATE TABLE IF NOT EXISTS index_runs (
  run_id VARCHAR PRIMARY KEY,
  bucket VARCHAR NOT NULL,
  mode VARCHAR NOT NULL,
  source_manifest VARCHAR,
  started_at TIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  status VARCHAR NOT NULL,
  rows BIGINT,
  bytes BIGINT,
  list_requests BIGINT,
  error VARCHAR
);

CREATE TABLE IF NOT EXISTS prefix_stats (
  bucket VARCHAR NOT NULL,
  prefix VARCHAR NOT NULL,
  parent_prefix VARCHAR NOT NULL,
  depth SMALLINT NOT NULL,
  objects BIGINT NOT NULL,
  bytes BIGINT NOT NULL,
  noncurrent_objects BIGINT NOT NULL,
  noncurrent_bytes BIGINT NOT NULL,
  oldest TIMESTAMP,
  newest TIMESTAMP,
  PRIMARY KEY (bucket, prefix)
);

CREATE TABLE IF NOT EXISTS multipart_uploads (
  bucket VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  upload_id VARCHAR NOT NULL,
  initiated TIMESTAMP,
  parts_bytes BIGINT,
  PRIMARY KEY (bucket, upload_id)
);

CREATE TABLE IF NOT EXISTS lifecycle_rules (
  bucket VARCHAR NOT NULL,
  rule_id VARCHAR NOT NULL,
  prefix VARCHAR,
  tags VARCHAR,
  min_size BIGINT,
  actions VARCHAR,
  PRIMARY KEY (bucket, rule_id)
);

CREATE TABLE IF NOT EXISTS iceberg_tables (
  bucket VARCHAR NOT NULL,
  location VARCHAR NOT NULL,
  latest_metadata VARCHAR,
  format_version INTEGER,
  PRIMARY KEY (bucket, location)
);

CREATE TABLE IF NOT EXISTS iceberg_files (
  bucket VARCHAR NOT NULL,
  table_location VARCHAR NOT NULL,
  snapshot VARCHAR,
  path VARCHAR NOT NULL,
  size BIGINT,
  kind VARCHAR
);

CREATE TABLE IF NOT EXISTS findings (
  finding_id VARCHAR PRIMARY KEY,
  run_id VARCHAR NOT NULL,
  analyzer VARCHAR NOT NULL,
  bucket VARCHAR NOT NULL,
  prefix VARCHAR,
  severity VARCHAR NOT NULL,
  reclaimable_bytes BIGINT NOT NULL,
  details VARCHAR,
  status VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS action_plans (
  plan_id VARCHAR PRIMARY KEY,
  bucket VARCHAR NOT NULL,
  created_by VARCHAR NOT NULL,
  action_type VARCHAR NOT NULL,
  params VARCHAR,
  status VARCHAR NOT NULL,
  object_count BIGINT NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  sample VARCHAR,
  request_estimate BIGINT,
  dry_run_at TIMESTAMP,
  approved_by VARCHAR,
  approved_at TIMESTAMP,
  error VARCHAR,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS action_plan_items (
  item_id VARCHAR PRIMARY KEY,
  plan_id VARCHAR NOT NULL,
  bucket VARCHAR NOT NULL,
  key VARCHAR NOT NULL,
  version_id VARCHAR,
  upload_id VARCHAR,
  expected_etag VARCHAR,
  expected_last_modified TIMESTAMP,
  size BIGINT,
  status VARCHAR NOT NULL,
  error VARCHAR,
  result VARCHAR,
  executed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  actor VARCHAR NOT NULL,
  action VARCHAR NOT NULL,
  bucket VARCHAR,
  params VARCHAR,
  result VARCHAR
);

CREATE TABLE IF NOT EXISTS saved_queries (
  query_id VARCHAR PRIMARY KEY,
  name VARCHAR NOT NULL,
  sql VARCHAR NOT NULL,
  created_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key VARCHAR PRIMARY KEY,
  value VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics_daily (
  day DATE NOT NULL,
  bucket VARCHAR NOT NULL,
  storage_class VARCHAR NOT NULL,
  objects BIGINT NOT NULL,
  bytes BIGINT NOT NULL,
  PRIMARY KEY (day, bucket, storage_class)
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id VARCHAR PRIMARY KEY,
  kind VARCHAR NOT NULL,
  bucket VARCHAR,
  status VARCHAR NOT NULL,
  progress DOUBLE,
  message VARCHAR,
  log VARCHAR,
  result VARCHAR,
  error VARCHAR,
  created_at TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS schedules (
  schedule_id VARCHAR PRIMARY KEY,
  bucket VARCHAR,
  kind VARCHAR NOT NULL,
  cron VARCHAR NOT NULL,
  params VARCHAR,
  enabled BOOLEAN NOT NULL,
  webhook_url VARCHAR,
  reclaim_threshold BIGINT,
  last_run_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ingest_batch (
  bucket VARCHAR,
  key VARCHAR,
  version_id VARCHAR,
  is_latest BOOLEAN,
  is_delete_marker BOOLEAN,
  size BIGINT,
  last_modified TIMESTAMP,
  etag VARCHAR,
  storage_class VARCHAR,
  is_multipart BOOLEAN,
  checksum_algo VARCHAR,
  encryption VARCHAR,
  replication VARCHAR,
  it_access_tier VARCHAR,
  object_lock_mode VARCHAR
);
