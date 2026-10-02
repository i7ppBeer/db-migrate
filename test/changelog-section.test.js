/**
 * scripts/changelog-section.mjs — the release notes CI publishes per tag
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import { extractChangelogSection } from '../scripts/changelog-section.mjs';

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
    const unreleased = run('Unreleased');
    expect(unreleased.status).toBe(0);
    expect(unreleased.stdout).toContain('### Upgrade guide');
  });

  it('the repository CHANGELOG has a non-empty Unreleased section', () => {
    expect(extractChangelogSection(fs.readFileSync('CHANGELOG.md', 'utf-8'), 'Unreleased')).not.toBe('');
  });
});
