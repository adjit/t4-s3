const op = (summary: string, extra?: Record<string, unknown>) => ({
  summary,
  responses: {
    "200": { description: "JSON body" },
    "400": { description: "Validation problem", content: { "application/problem+json": {} } },
    "401": { description: "Missing or invalid bearer token", content: { "application/problem+json": {} } },
  },
  ...extra,
});

export const openApiDocument = {
  openapi: "3.0.3",
  info: {
    title: "t4",
    version: "0.1.0",
    description: "Manage S3 connections, buckets, and bucket policies. Object keys are the key query parameter because keys contain slashes.",
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/health": { get: op("Process health", { security: [] }) },
    "/metrics": { get: op("Prometheus gauges", { security: [] }) },
    "/api/health": { get: op("API health", { security: [] }) },
    "/api/metrics": { get: op("Prometheus gauges") },
    "/api/openapi.json": { get: op("This document") },
    "/api/connections": {
      get: op("List connections. Secrets are not included. Each row has has_credentials."),
      post: op("Register a connection. Body is ConnectionInput. Response is { connectionId }."),
    },
    "/api/connections/test": {
      post: op("Try endpoint and keys without saving. Optional body.bucket lists that bucket. Response is { ok, summary }."),
    },
    "/api/connections/{connectionId}": {
      patch: op("Replace a connection, including its access key. Body is ConnectionInput."),
      delete: op("Remove a connection and its stored secret."),
    },
    "/api/connections/{connectionId}/buckets": {
      get: op("List buckets on the live store. Response is { buckets }."),
      post: op("Create a bucket on the live store. Body { name }."),
    },
    "/api/connections/{connectionId}/buckets/{bucket}/policy": {
      get: op("Read the bucket policy. Response is { policy } and policy is null when the bucket has none."),
      put: op("Set the bucket policy. Body { policy } is a JSON object or a JSON string."),
      delete: op("Remove the bucket policy."),
    },
    "/api/connections/{connectionId}/buckets/{bucket}": {
      delete: op("Delete an empty bucket from the store. Body { confirmation } must equal the bucket name. Non-empty buckets are refused with 409."),
    },
    "/api/buckets/{bucket}/folder": {
      get: op("Live count and size of current objects under query prefix, plus blocked (a reason string, or null when deleting is allowed)."),
    },
    "/api/buckets/{bucket}/folders": {
      post: op("Create a folder marker. Body { prefix, name } creates prefix + name + '/'. Needs writes enabled. Re-indexes the new prefix."),
      delete: op("Delete every current object under a folder. Body { prefix, confirmation } where confirmation is the folder name. Needs writes enabled and no protected prefix. Response { deleted, failed, bytes }."),
    },
    "/api/buckets": {
      get: op("List registered buckets"),
      post: op("Register a bucket. Body is BucketInput. Response is the bucket summary."),
    },
    "/api/buckets/{bucket}": {
      get: op("Bucket summary"),
      patch: op("Update writeEnabled, protectedPrefixes, staleAfterHours, indexMode, inventoryUri"),
    },
    "/api/buckets/{bucket}/probe": { post: op("Probe store capabilities") },
    "/api/buckets/{bucket}/index/estimate": { post: op("Estimate a crawl. Body { prefix?, depth? }.") },
    "/api/buckets/{bucket}/index": { post: op("Start an index job. Body { prefix?, depth? }. Response { jobId }.") },
    "/api/buckets/{bucket}/index-inventory": {
      post: op("Start an inventory index job. Body { parquetPath, expectedRows? }. Response { jobId }."),
    },
    "/api/jobs": { get: op("List jobs") },
    "/api/jobs/{id}": { get: op("Get one job. result and log are parsed JSON when they are JSON text.") },
    "/api/jobs/{id}/events": { get: op("Server-sent events. event: job every 500ms until done, failed, or 60s.") },
    "/api/buckets/{bucket}/browse": { get: op("Browse one prefix. Query prefix, cursor, limit.") },
    "/api/buckets/{bucket}/tree": { get: op("Child prefixes. Query prefix.") },
    "/api/buckets/{bucket}/search": {
      get: op("Search. Query prefix, q, glob, regex, minSize, maxSize, modifiedAfter, modifiedBefore, storageClass, ext, versionState, cursor, limit."),
    },
    "/api/buckets/{bucket}/objects": { get: op("Object detail. Query key is required.") },
    "/api/buckets/{bucket}/objects/download-url": { get: op("Presigned URL. Query key and optional expires seconds.") },
    "/api/buckets/{bucket}/objects/preview": { get: op("Preview Parquet, CSV, JSON, or JSONL. Query key.") },
    "/api/query": { post: op("Run console SQL. Body { sql, limit? }. SELECT, DESCRIBE, EXPLAIN, or SUMMARIZE only.") },
    "/api/export": { post: op("Export a SELECT. Body { sql, format: csv|parquet }. Response { id, fileName, url }.") },
    "/api/exports/{fileName}": { get: op("Download an export. fileName must be uuid.csv or uuid.parquet.") },
    "/api/saved-queries": {
      get: op("List saved queries"),
      post: op("Save a query. Body { name, sql }. Response { id }."),
    },
    "/api/saved-queries/{id}": { delete: op("Delete a saved query") },
    "/api/analyzers": { get: op("List analyzers") },
    "/api/analyzers/run": { post: op("Start analyzer job. Body { bucket, analyzerId?, overrides? }. Response { jobId }.") },
    "/api/findings": { get: op("List findings. Query bucket, status.") },
    "/api/findings/{id}": { patch: op("Set finding status. Body { status }.") },
    "/api/plans": {
      get: op("List plans. Query bucket."),
      post: op("Create a plan. Body { bucket, findingIds, actor? }. Response { planId }. Empty findingIds is 400."),
    },
    "/api/plans/{id}": { get: op("Get a plan and up to 200 items") },
    "/api/plans/{id}/dry-run": { post: op("Dry-run a plan") },
    "/api/plans/{id}/approve": { post: op("Approve a plan. Body { confirmation } is the bucket name when required.") },
    "/api/plans/{id}/execute": { post: op("Execute an approved plan") },
    "/api/plans/{id}/cancel": { post: op("Cancel a plan") },
    "/api/plans/{id}/undo": { post: op("Undo a finished versioned delete. Response { undone }.") },
    "/api/audit": { get: op("Audit log. Query bucket.") },
    "/api/tables": { get: op("Iceberg tables. Query bucket is required.") },
    "/api/schedules": {
      get: op("List schedules. Cron fields are UTC."),
      post: op("Create a schedule. Body { bucket, kind, cron, enabled, webhookUrl, reclaimThreshold }. Response { id }."),
    },
    "/api/settings/{key}": {
      get: op("Read kill_switch or theme"),
      put: op("Write kill_switch or theme. Body { value }."),
    },
  },
};
