export interface DerivedKey {
  parentPrefix: string;
  name: string;
  ext: string | null;
  depth: number;
}

export function deriveKey(key: string): DerivedKey {
  const slash = key.lastIndexOf("/");
  const parentPrefix = slash >= 0 ? key.slice(0, slash + 1) : "";
  const name = slash >= 0 ? key.slice(slash + 1) : key;
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : null;
  const depth = parentPrefix.length - parentPrefix.replaceAll("/", "").length;
  return { parentPrefix, name, ext, depth };
}

export function folderName(prefix: string): string {
  if (prefix === "") return "";
  const trimmed = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function isProtected(key: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => prefix !== "" && (key === prefix || key.startsWith(prefix)));
}
