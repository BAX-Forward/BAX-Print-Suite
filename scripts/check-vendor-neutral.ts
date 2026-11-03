// Usage: tsx scripts/check-vendor-neutral.ts [dir ...]
// Without arguments, scans the core directories added by Spec 008.
import { loadVendorNames, REPO_ROOT, scanRepository, SPEC_008_ROOTS } from './vendor-neutral.js';

const roots = process.argv.length > 2 ? process.argv.slice(2) : SPEC_008_ROOTS;
const findings = await scanRepository(REPO_ROOT, roots, await loadVendorNames());

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: "${finding.term}" is a vendor, model or device command language name`);
  }
  console.error(`\n${findings.length} vendor-specific name(s) found; move them to plugins/ or a device capability profile.`);
  process.exitCode = 1;
} else {
  console.log(`vendor-neutral check passed (${roots.join(', ')})`);
}
