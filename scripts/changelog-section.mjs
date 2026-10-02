#!/usr/bin/env node
/**
 * Print one version's section of CHANGELOG.md — the release notes CI
 * publishes for a vX.Y.Z tag. Exits 1 (and prints why) when the section is
 * missing or empty, so a release can't go out without notes.
 *
 *   node scripts/changelog-section.mjs 3.0.0 [CHANGELOG.md]
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * The body under `## [version]` up to the next `## ` heading or `---` rule,
 * trimmed; null if there's no such heading.
 */
export function extractChangelogSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = lines.findIndex(l => new RegExp(`^## \\[${escaped}\\](\\s|$)`).test(l));
  if (start === -1) return null;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line) || /^---\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const [version, file = 'CHANGELOG.md'] = process.argv.slice(2);
  if (!version) {
    console.error('usage: node scripts/changelog-section.mjs <version> [CHANGELOG.md]');
    process.exit(2);
  }
  const section = extractChangelogSection(fs.readFileSync(file, 'utf-8'), version);
  if (section === null) {
    console.error(`${file} has no "## [${version}]" section — write the release notes there first (see "Releasing" in ${file}).`);
    process.exit(1);
  }
  if (section === '') {
    console.error(`${file}'s "## [${version}]" section is empty — write the release notes there first.`);
    process.exit(1);
  }
  process.stdout.write(`${section}\n`);
}
