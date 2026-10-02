/**
 * scripts/changelog-section.mjs — the release notes CI publishes per tag
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { extractChangelogSection } from '../scripts/changelog-section.mjs';

const version = JSON.parse(fs.readFileSync('package.json', 'utf-8')).version;

const sample = [
  '# Changelog', '', '## [Unreleased]', '', '- next thing', '',
  '## [3.0.0] - 2026-10-10', '', '### TL;DR', '- big change', '',
  '## [2.10.0] - 2026-09-01', '', '- older', '', '---', '', '## Releasing', '1. steps'
].join('\n');

describe('extractChangelogSection', () => {
  it('returns one version\'s body, stopping at the next heading or rule', () => {
    expect(extractChangelogSection(sample, '3.0.0')).toBe('### TL;DR\n- big change');
    expect(extractChangelogSection(sample, '2.10.0')).toBe('- older');
    expect(extractChangelogSection(sample, 'Unreleased')).toBe('- next thing');
  });

  it('does not confuse versions that share a prefix, and returns null when missing', () => {
    expect(extractChangelogSection(sample, '2.1.0')).toBeNull();
    expect(extractChangelogSection(sample, '3.0')).toBeNull();
  });

  it('CLI exits 1 for a missing or empty section and prints the notes otherwise', () => {
    const run = (v) => spawnSync(process.execPath, ['scripts/changelog-section.mjs', v], { encoding: 'utf-8' });
    expect(run('0.0.1').status).toBe(1);
    expect(run('0.0.1').stderr).toContain('has no "## [0.0.1]" section');
    const current = run(version);
    expect(current.status).toBe(0);
    expect(current.stdout.trim()).not.toBe('');
  });

  // The release a vX.Y.Z tag would publish must have notes — catches a
  // version bump without them here instead of at tag time.
  it('CHANGELOG.md has non-empty notes for the version in package.json', () => {
    const section = extractChangelogSection(fs.readFileSync('CHANGELOG.md', 'utf-8'), version);
    expect(section, `CHANGELOG.md needs a "## [${version}]" section`).toBeTruthy();
  });
});
