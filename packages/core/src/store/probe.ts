import {
  classifyStoreError,
  type Capabilities,
  type CapabilityState,
  type ObjectStore,
} from "./types.js";

export async function probeStore(store: ObjectStore, bucket: string): Promise<Capabilities> {
  const notes: Record<string, string> = {};
  const listObjects = await check("list_objects", notes, () => store.list({ bucket, delimiter: "/", prefix: "" }));
  const versioningResult = await checkValue("versioning", notes, () => store.getVersioning(bucket));
  const listVersions = await check("list_versions", notes, () => store.list({ bucket, versions: true, prefix: "" }));
  const multipart = await check("multipart", notes, () => store.listMultipart(bucket));
  const tagging = await check("tagging", notes, async () => {
    const page = await store.list({ bucket, prefix: "" });
    const first = page.objects[0];
    if (!first) {
      notes.tagging = "No object was available to read tags.";
      return "not_tested" as CapabilityState;
    }
    await store.head(bucket, first.key, first.versionId);
    return "supported" as CapabilityState;
  });
  const lifecycle = await check("lifecycle", notes, () => store.getLifecycle(bucket));
  const objectLock = await check("object_lock", notes, () => store.getObjectLock(bucket));
  const presign = await check("presign", notes, async () => {
    await store.presign(bucket, "t4-capability-probe", 60);
  });
  const checksums = await check("checksums", notes, async () => {
    const page = await store.list({ bucket, prefix: "" });
    const withChecksum = page.objects.find((object) => object.checksumAlgo);
    if (!withChecksum) {
      notes.checksums = "No indexed object reported a checksum.";
      return "not_tested" as CapabilityState;
    }
    return "supported" as CapabilityState;
  });
  const inventory = await check("inventory", notes, async () => {
    const id = await store.getInventory(bucket);
    if (!id) return "not_found" as CapabilityState;
    return "supported" as CapabilityState;
  });
  return {
    list_objects: listObjects,
    list_versions: listVersions,
    versioning: versioningResult.state,
    versioning_enabled: versioningResult.value?.enabled === true,
    multipart,
    tagging,
    lifecycle,
    object_lock: objectLock,
    presign,
    checksums,
    inventory,
    notes,
  };
}

async function check(
  feature: string,
  notes: Record<string, string>,
  fn: () => Promise<unknown>,
): Promise<CapabilityState> {
  try {
    const result = await fn();
    if (result === "supported" || result === "not_supported" || result === "not_tested" || result === "not_found") {
      return result;
    }
    return "supported";
  } catch (error) {
    const state = classifyStoreError(error);
    notes[feature] = error instanceof Error ? error.message : String(error);
    return state;
  }
}

async function checkValue<T>(
  feature: string,
  notes: Record<string, string>,
  fn: () => Promise<T>,
): Promise<{ state: CapabilityState; value?: T }> {
  try {
    const value = await fn();
    return { state: "supported", value };
  } catch (error) {
    const state = classifyStoreError(error);
    notes[feature] = error instanceof Error ? error.message : String(error);
    return { state };
  }
}
