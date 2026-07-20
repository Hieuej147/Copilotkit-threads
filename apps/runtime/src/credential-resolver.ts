import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { CredentialResolver } from "./ports.js";

export class EnvironmentFileCredentialResolver implements CredentialResolver {
  constructor(private readonly fileRoot: string) {}

  async resolve(reference: string | null): Promise<string | null> {
    if (!reference) return null;
    if (reference.startsWith("env:")) {
      const name = reference.slice(4);
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) throw new Error("INVALID_CREDENTIAL_REFERENCE");
      return process.env[name]?.trim() || null;
    }
    if (reference.startsWith("file:")) {
      const root = resolve(this.fileRoot);
      const target = resolve(root, reference.slice(5).replace(/^\/+/, ""));
      if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("INVALID_CREDENTIAL_REFERENCE");
      return (await readFile(target, "utf8")).trim() || null;
    }
    throw new Error("INVALID_CREDENTIAL_REFERENCE");
  }
}
