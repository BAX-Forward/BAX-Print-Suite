// Usage: tsx scripts/check-vendor-neutral.ts [dir ...]
// Without arguments, scans every directory under packages/ and apps/ (plugins/ and docs/research/ are exempt).
import { defaultRoots, loadVendorNames, REPO_ROOT, scanRepository } from './vendor-neutral.js';

const roots = process.argv.length > 2 ? process.argv.slice(2) : await defaultRoots(REPO_ROOT);
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
