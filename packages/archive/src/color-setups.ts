import type { ColorSetupRevision } from '@bax-print/core';

/** Color setup resolution as provided by the media library (Spec 005). */
export interface ColorSetupResolver {
  getRevision(id: string): Promise<ColorSetupRevision | undefined>;
  /** Current head revision for a (device, medium) pair. */
  getHead(deviceId: string, mediumId: string): Promise<ColorSetupRevision | undefined>;
  getProfileBytes(profileId: string): Promise<Uint8Array | undefined>;
}

const pairKey = (deviceId: string, mediumId: string): string => `${deviceId}\u0000${mediumId}`;

/** In-memory resolver for tests and for running before the media library is wired in. */
export class StaticColorSetupResolver implements ColorSetupResolver {
  private readonly revisions = new Map<string, ColorSetupRevision>();
  private readonly heads = new Map<string, string>();
  private readonly profiles = new Map<string, Uint8Array>();

  /** Adds an immutable revision; by default it becomes the head of its (device, medium) pair. */
  addRevision(revision: ColorSetupRevision, options: { head?: boolean } = {}): this {
    this.revisions.set(revision.id, structuredClone(revision));
    if (options.head ?? true) {
      this.heads.set(pairKey(revision.deviceId, revision.mediumId), revision.id);
    }
    return this;
  }

  addProfile(profileId: string, bytes: Uint8Array): this {
    this.profiles.set(profileId, new Uint8Array(bytes));
    return this;
  }

  async getRevision(id: string): Promise<ColorSetupRevision | undefined> {
    const revision = this.revisions.get(id);
    return revision ? structuredClone(revision) : undefined;
  }

  async getHead(deviceId: string, mediumId: string): Promise<ColorSetupRevision | undefined> {
    const id = this.heads.get(pairKey(deviceId, mediumId));
    return id === undefined ? undefined : this.getRevision(id);
  }

  async getProfileBytes(profileId: string): Promise<Uint8Array | undefined> {
    const bytes = this.profiles.get(profileId);
    return bytes ? new Uint8Array(bytes) : undefined;
  }
}
