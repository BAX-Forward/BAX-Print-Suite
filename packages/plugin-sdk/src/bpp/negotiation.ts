/**
 * Version negotiation for BPP `initialize` (ARCHITECTURE.md §3.6). Interfaces are matched by
 * SemVer range; protocol-style version lists are matched on the highest common major.minor.
 */
import type { InterfaceOffer, InterfaceRequirement } from './protocol.js';
import { compareSemver, parseSemver, satisfies, type Version } from './semver.js';

function highest(versions: readonly Version[]): Version | undefined {
  return versions.reduce<Version | undefined>(
    (best, candidate) => (best === undefined || compareSemver(candidate, best) > 0 ? candidate : best),
    undefined,
  );
}

function format(version: Version): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length === 0 ? base : `${base}-${version.prerelease.join('.')}`;
}

function minorKey(version: Version): string {
  return `${version.major}.${version.minor}`;
}

/**
 * Picks the highest major.minor that both sides list. Within that minor the result is the lower
 * of each side's highest patch, so both peers fully understand it. Invalid entries are ignored.
 * Returns undefined when the sides share no major.minor.
 */
export function negotiateVersion(local: readonly string[], remote: readonly string[]): string | undefined {
  const parse = (values: readonly string[]): Version[] =>
    values.map((value) => parseSemver(value)).filter((value): value is Version => value !== undefined);
  const localVersions = parse(local);
  const remoteVersions = parse(remote);
  const remoteMinors = new Set(remoteVersions.map(minorKey));
  const common = localVersions.filter((version) => remoteMinors.has(minorKey(version)));
  const best = highest(common);
  if (!best) {
    return undefined;
  }
  const key = minorKey(best);
  const localTop = highest(localVersions.filter((version) => minorKey(version) === key));
  const remoteTop = highest(remoteVersions.filter((version) => minorKey(version) === key));
  if (!localTop || !remoteTop) {
    return undefined;
  }
  return format(compareSemver(localTop, remoteTop) <= 0 ? localTop : remoteTop);
}

export interface InterfaceNegotiation {
  /** One offer per satisfied requirement: the highest offered version inside the range. */
  selected: InterfaceOffer[];
  /** Requirements no offer satisfies. */
  missing: InterfaceRequirement[];
}

/** Matches host requirements (ranges) against plugin offers (concrete versions). */
export function negotiateInterfaces(
  requirements: readonly InterfaceRequirement[],
  offers: readonly InterfaceOffer[],
): InterfaceNegotiation {
  const selected: InterfaceOffer[] = [];
  const missing: InterfaceRequirement[] = [];
  for (const requirement of requirements) {
    const candidates = offers.filter(
      (offer) => offer.interface === requirement.interface && satisfies(offer.version, requirement.versions),
    );
    const best = candidates.reduce<InterfaceOffer | undefined>((current, offer) => {
      if (current === undefined) return offer;
      const a = parseSemver(offer.version);
      const b = parseSemver(current.version);
      return a && b && compareSemver(a, b) > 0 ? offer : current;
    }, undefined);
    if (best) {
      selected.push({ interface: best.interface, version: best.version });
    } else {
      missing.push({ interface: requirement.interface, versions: requirement.versions });
    }
  }
  return { selected, missing };
}
