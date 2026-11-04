import {
  DEFAULT_PROFILE,
  EXAMPLE_PROFILES,
  builtinRegistry,
  validateProfile,
  type CheckRegistry,
  type PreflightProfile,
} from "@bax-print/inspect";
import { conflict, invalid, notFound } from "./errors.js";
import type { ProfileStore } from "./stores.js";

/** `/preflight-profiles` CRUD. Built-in profiles are listed with the custom ones and are read-only. */

export interface ProfileView extends PreflightProfile {
  builtin: boolean;
}

export const BUILTIN_PROFILES: readonly PreflightProfile[] = [DEFAULT_PROFILE, ...EXAMPLE_PROFILES];
const BUILTIN_IDS = new Set(BUILTIN_PROFILES.map((p) => p.id));

export class ProfileService {
  private readonly store: ProfileStore;
  private readonly registry: CheckRegistry;

  constructor(store: ProfileStore, registry: CheckRegistry = builtinRegistry()) {
    this.store = store;
    this.registry = registry;
  }

  async list(): Promise<ProfileView[]> {
    const custom = await this.store.list();
    return [...BUILTIN_PROFILES.map((p) => ({ ...p, builtin: true })), ...custom.map((p) => ({ ...p, builtin: false }))];
  }

  async find(id: string): Promise<PreflightProfile | undefined> {
    return BUILTIN_PROFILES.find((p) => p.id === id) ?? (await this.store.get(id));
  }

  async get(id: string): Promise<ProfileView> {
    const profile = await this.find(id);
    if (!profile) throw notFound("Preflight profile", id);
    return { ...profile, builtin: BUILTIN_IDS.has(id) };
  }

  async create(input: unknown): Promise<ProfileView> {
    const profile = this.validated(input);
    if (await this.find(profile.id)) throw conflict(`Preflight profile ${profile.id} already exists`);
    await this.store.put(profile);
    return { ...profile, builtin: false };
  }

  async replace(id: string, input: unknown): Promise<ProfileView> {
    this.assertWritable(id);
    const profile = this.validated(input);
    if (profile.id !== id) throw invalid(`Profile id ${JSON.stringify(profile.id)} does not match the URL (${id})`);
    if (!(await this.store.get(id))) throw notFound("Preflight profile", id);
    await this.store.put(profile);
    return { ...profile, builtin: false };
  }

  async delete(id: string): Promise<void> {
    this.assertWritable(id);
    if (!(await this.store.delete(id))) throw notFound("Preflight profile", id);
  }

  private validated(input: unknown): PreflightProfile {
    const result = validateProfile(input, this.registry);
    if (!result.ok) throw invalid("Invalid preflight profile", result.errors);
    return result.value;
  }

  private assertWritable(id: string): void {
    if (BUILTIN_IDS.has(id)) throw conflict(`Preflight profile ${id} is built in and can't be changed; copy it under a new id`);
  }
}
