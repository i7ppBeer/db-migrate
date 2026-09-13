/**
 * Diff two schema snapshots (from adapter.getSchemaSnapshot()) taken before
 * and after a migration run, so `sync` can show what actually changed
 * instead of just the final state.
 *
 * Works for both adapter shapes:
 *   MariaDB:  { table, engine, rows, columns: [{name, type, nullable, key, default}] }
 *   MongoDB:  { collection, count, indexes, fields: [{name, type}] }
 */

/** @private Get the container's identity name regardless of adapter shape. */
function containerName(item) {
  return item.table ?? item.collection;
}

/** @private Get the container's field list regardless of adapter shape. */
function containerFields(item) {
  return item.columns ?? item.fields;
}

/**
 * @param {Array} before - snapshot taken before running migrations
 * @param {Array} after - snapshot taken after running migrations
 * @returns {{added: Array, removed: Array, changed: Array, unchangedCount: number}}
 *   changed[] entries: { name, addedFields, removedFields, changedFields: [{name, before, after}] }
 */
export function diffSchemaSnapshots(before, after) {
  const beforeMap = new Map(before.map(item => [containerName(item), item]));
  const afterMap = new Map(after.map(item => [containerName(item), item]));

  const added = [];
  const removed = [];
  const changed = [];
  let unchangedCount = 0;

  for (const [name, afterItem] of afterMap) {
    if (!beforeMap.has(name)) {
      added.push(afterItem);
      continue;
    }

    const beforeItem = beforeMap.get(name);
    const beforeFields = new Map(containerFields(beforeItem).map(f => [f.name, f]));
    const afterFields = new Map(containerFields(afterItem).map(f => [f.name, f]));

    const addedFields = [];
    const removedFields = [];
    const changedFields = [];

    for (const [fieldName, afterField] of afterFields) {
      if (!beforeFields.has(fieldName)) {
        addedFields.push(afterField);
        continue;
      }
      const beforeField = beforeFields.get(fieldName);
      // Compare only the keys both shapes actually have in common, so a
      // MariaDB column and a MongoDB field are compared consistently.
      const relevantKeys = ['type', 'nullable', 'key'].filter(k => k in beforeField || k in afterField);
      const isDifferent = relevantKeys.some(k => beforeField[k] !== afterField[k]);
      if (isDifferent) {
        changedFields.push({ name: fieldName, before: beforeField, after: afterField });
      }
    }
    for (const [fieldName, beforeField] of beforeFields) {
      if (!afterFields.has(fieldName)) removedFields.push(beforeField);
    }

    if (addedFields.length > 0 || removedFields.length > 0 || changedFields.length > 0) {
      changed.push({ name, addedFields, removedFields, changedFields });
    } else {
      unchangedCount++;
    }
  }

  for (const [name, beforeItem] of beforeMap) {
    if (!afterMap.has(name)) removed.push(beforeItem);
  }

  return { added, removed, changed, unchangedCount };
}

/**
 * True if the diff represents no actual change at all.
 * @param {{added: Array, removed: Array, changed: Array}} diff
 */
export function isDiffEmpty(diff) {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}
