import { describe, expect, test } from "vitest";
import { MemoryStore } from "./memory.js";
import { testConnection } from "./test-connection.js";

describe("testConnection", () => {
  test("lists buckets and one bucket without saving anything", async () => {
    const store = new MemoryStore();
    store.put({
      bucket: "demo",
      key: "readme.txt",
      versionId: null,
      isLatest: true,
      isDeleteMarker: false,
      size: 4,
      lastModified: new Date(),
      etag: "abc",
      storageClass: "STANDARD",
      isMultipart: false,
      checksumAlgo: null,
      encryption: null,
      replication: null,
      itAccessTier: null,
      objectLockMode: null,
      legalHold: false,
    });

    const all = await testConnection(store);
    expect(all.summary).toContain("demo");

    const one = await testConnection(store, "demo");
    expect(one.summary).toContain("readme.txt");
  });
});
