export { T4Error, isT4Error } from "./errors.js";
export { plain, plainRow, asString, asNumber, asBoolean, parseJson } from "./plain.js";
export { deriveKey, folderName, isProtected } from "./keys.js";
export type { DerivedKey } from "./keys.js";
export { SecretStore } from "./secrets.js";
export type { SecretMaterial } from "./secrets.js";
export { Database, execScript, queryAll, queryOne, execute, sqlLiteral, duckPath } from "./duck/database.js";
export type { SqlParams } from "./duck/database.js";
export { MemoryStore } from "./store/memory.js";
export type { MemoryObject } from "./store/memory.js";
export { S3ObjectStore, normalizeEndpoint } from "./store/s3.js";
export { testConnection, connectionError } from "./store/test-connection.js";
export type { S3ConnectionSettings } from "./store/s3.js";
export { probeStore } from "./store/probe.js";
export { StoreFeatureError, classifyStoreError } from "./store/types.js";
export type {
  CapabilityState,
  Capabilities,
  ListedObject,
  ListPage,
  ObjectHead,
  MultipartUpload,
  LifecycleRule,
  DeleteRequest,
  DeleteResultItem,
  StoreErrorItem,
  ObjectStore,
} from "./store/types.js";
export { toRaw, toTimestamp, estimateCrawl, crawlBucket } from "./index/crawl.js";
export type { RawObject } from "./index/crawl.js";
export { stageAndSwap, loadInventoryParquet, rebuildPrefixStats } from "./index/ingest.js";
export { stripSqlComments, assertSafeConsoleSql, capSelect } from "./query/guard.js";
export type { SafeSql } from "./query/guard.js";
export { buildObjectQuery, buildFolderQuery } from "./query/browse.js";
export type { SearchFilters, BuiltQuery } from "./query/browse.js";
export { loadAnalyzers, loadAnalyzer, runAnalyzer, defaultAnalyzersDir } from "./analyzers/runner.js";
export type { Analyzer, AnalyzerAction, AnalyzerParam } from "./analyzers/runner.js";
export { createPlan, dryRunPlan, approvePlan, cancelPlan, executePlan, undoPlan } from "./actions/engine.js";
export type { BucketPolicy } from "./actions/engine.js";
export { parseCron, cronMatches } from "./schedule.js";
export type { CronParts } from "./schedule.js";
export { Workspace, detectFormat, analyzerDefaults } from "./workspace.js";
export type { ConnectionInput, BucketInput, WorkspaceOptions } from "./workspace.js";
