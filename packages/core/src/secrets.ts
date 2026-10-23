import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export interface SecretMaterial {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
}

export class SecretStore {
  constructor(private readonly filePath: string) {}

  private readAll(): Record<string, SecretMaterial> {
    if (!existsSync(this.filePath)) return {};
    const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, SecretMaterial>;
  }

  private writeAll(secrets: Record<string, SecretMaterial>): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(secrets, null, 2), "utf8");
  }

  put(ref: string, secret: SecretMaterial): void {
    const all = this.readAll();
    all[ref] = secret;
    this.writeAll(all);
  }

  get(ref: string): SecretMaterial | undefined {
    return this.readAll()[ref];
  }

  delete(ref: string): void {
    const all = this.readAll();
    delete all[ref];
    this.writeAll(all);
  }
}
