/**
 * migrationsDir may be one directory or, for DCL (mode: 'repeatable'), a list
 * of them — e.g. ['./shared', './prod-tw']: accounts every server needs, plus
 * the ones only this server has. The files are merged into one set ordered by
 * file name, the same order a single directory runs in.
 *
 * File names stay the identity (the checksum table/collection is keyed by
 * them), so the same name in two directories is an error rather than one
 * silently shadowing the other.
 */

import fs from 'fs/promises';
import path from 'path';

/** Always an array; [] when unset. */
export function toDirList(migrationsDir) {
  if (migrationsDir == null || migrationsDir === '') return [];
  return Array.isArray(migrationsDir) ? migrationsDir : [migrationsDir];
}

/** "dir" or "dir1, dir2" — for messages. */
export function describeDirs(migrationsDir) {
  return toDirList(migrationsDir).join(', ');
}

/**
 * Resolve each directory against baseDir. An array is accepted only for DCL
 * (mode: 'repeatable'); a DDL changelog must come from exactly one directory.
 */
export function resolveDirs(migrationsDir, baseDir, mode) {
  if (Array.isArray(migrationsDir)) {
    if (mode !== 'repeatable') {
      throw new Error(`migrationsDir lists ${migrationsDir.length} directories, but only DCL configs (mode: 'repeatable') accept a list — a DDL config takes one directory.`);
    }
    if (migrationsDir.length === 0) {
      throw new Error(`migrationsDir is an empty list — name at least one directory.`);
    }
    for (const d of migrationsDir) {
      if (typeof d !== 'string' || d === '') throw new Error(`migrationsDir entries must be non-empty paths, got ${JSON.stringify(d)}.`);
    }
    return migrationsDir.map(d => path.resolve(baseDir, d));
  }
  if (!migrationsDir) return migrationsDir;
  return path.resolve(baseDir, migrationsDir);
}

/**
 * List the files `predicate(fileName)` accepts across every directory,
 * sorted by name. Throws when one name appears in more than one directory.
 * @returns {Promise<Array<{fileName: string, filePath: string, dir: string}>>}
 */
export async function listMigrationFiles(migrationsDir, predicate) {
  const seen = new Map();
  for (const dir of toDirList(migrationsDir)) {
    for (const fileName of await fs.readdir(dir)) {
      if (!predicate(fileName)) continue;
      if (seen.has(fileName)) {
        throw new Error(`${fileName} is in both ${seen.get(fileName).dir} and ${dir} — file names must be unique across migrationsDir (they identify the script in the checksum record). Rename one of them.`);
      }
      seen.set(fileName, { fileName, filePath: path.join(dir, fileName), dir });
    }
  }
  return [...seen.values()].sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
}

/**
 * The one directory a new file goes into. With a single directory that's
 * it; with a list, `wanted` (create-dcl --dir) must name one of them — by
 * path or by its last segment, e.g. 'prod-tw' for /…/dcl/prod-tw.
 */
export function pickDir(migrationsDir, wanted) {
  const dirs = toDirList(migrationsDir);
  if (dirs.length === 0) throw new Error('migrationsDir is not set in the config.');
  const listed = dirs.map(d => path.basename(d)).join(', ');
  if (!wanted) {
    if (dirs.length === 1) return dirs[0];
    throw new Error(`migrationsDir lists ${dirs.length} directories (${listed}) — say which one the new file goes into with --dir <name>.`);
  }
  const resolved = path.resolve(wanted);
  const trimmed = String(wanted).replace(/[\\/]+$/, '');
  const matches = dirs.filter(d => d === resolved || path.basename(d) === trimmed || d.endsWith(path.sep + path.normalize(trimmed).replace(/^\.[\\/]/, '')));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`--dir ${wanted} is not one of migrationsDir's directories (${listed}).`);
  throw new Error(`--dir ${wanted} matches more than one directory (${matches.join(', ')}) — give the full path.`);
}

/** The directory (if any) in the list that already has this file name. */
export async function findExisting(migrationsDir, fileName) {
  for (const dir of toDirList(migrationsDir)) {
    try {
      await fs.access(path.join(dir, fileName));
      return dir;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return null;
}
