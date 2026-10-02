/**
 * Tests for migrationsDir as a list of directories (DCL only)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { toDirList, resolveDirs, listMigrationFiles } from '../src/core/migration-dirs.js';
import { RepeatableRunner } from '../src/core/repeatable-runner.js';
import { BaseAdapter } from '../src/core/base-adapter.js';

describe('migration-dirs', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdirs-'));
    await fs.mkdir(path.join(root, 'shared'));
    await fs.mkdir(path.join(root, 'prod-tw'));
    await fs.writeFile(path.join(root, 'shared', 'R__01_readonly.sql'), 'SELECT 1;');
    await fs.writeFile(path.join(root, 'shared', 'R__03_reporting.sql'), 'SELECT 3;');
    await fs.writeFile(path.join(root, 'prod-tw', 'R__02_tw_app.sql'), 'SELECT 2;');
    await fs.writeFile(path.join(root, 'prod-tw', 'notes.txt'), 'ignored');
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('toDirList normalizes one directory, a list, or nothing', () => {
    expect(toDirList('./a')).toEqual(['./a']);
    expect(toDirList(['./a', './b'])).toEqual(['./a', './b']);
    expect(toDirList(undefined)).toEqual([]);
  });

  it('resolveDirs resolves every entry of a DCL list against the config directory', () => {
    expect(resolveDirs(['./shared', 'prod-tw'], root, 'repeatable'))
      .toEqual([path.join(root, 'shared'), path.join(root, 'prod-tw')]);
    expect(resolveDirs('./shared', root, undefined)).toBe(path.join(root, 'shared'));
  });

  it('resolveDirs rejects a list for DDL configs, and an empty list', () => {
    expect(() => resolveDirs(['./a', './b'], root, undefined)).toThrow(/only DCL configs/);
    expect(() => resolveDirs([], root, 'repeatable')).toThrow(/empty list/);
  });

  it('listMigrationFiles merges directories in file-name order', async () => {
    const files = await listMigrationFiles([path.join(root, 'shared'), path.join(root, 'prod-tw')], f => f.startsWith('R__'));
    expect(files.map(f => f.fileName)).toEqual(['R__01_readonly.sql', 'R__02_tw_app.sql', 'R__03_reporting.sql']);
    expect(files[1].filePath).toBe(path.join(root, 'prod-tw', 'R__02_tw_app.sql'));
  });

  it('listMigrationFiles rejects the same file name in two directories', async () => {
    await fs.writeFile(path.join(root, 'prod-tw', 'R__01_readonly.sql'), 'SELECT 99;');
    await expect(listMigrationFiles([path.join(root, 'shared'), path.join(root, 'prod-tw')], () => true))
      .rejects.toThrow(/R__01_readonly\.sql is in both .*shared and .*prod-tw/);
  });

  it('RepeatableRunner.getRepeatableFiles reads content from each file\'s own directory', async () => {
    const runner = new RepeatableRunner({});
    const files = await runner.getRepeatableFiles([path.join(root, 'shared'), path.join(root, 'prod-tw')]);
    expect(files.map(f => [f.fileName, f.content])).toEqual([
      ['R__01_readonly.sql', 'SELECT 1;'],
      ['R__02_tw_app.sql', 'SELECT 2;'],
      ['R__03_reporting.sql', 'SELECT 3;']
    ]);
  });

  it('a DDL adapter refuses a list of directories', () => {
    expect(() => new BaseAdapter({ migrationsDir: ['a', 'b'] })).toThrow(/only DCL configs/);
    expect(() => new BaseAdapter({ mode: 'repeatable', migrationsDir: ['a', 'b'] })).not.toThrow();
  });
});
