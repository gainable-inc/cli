/**
 * Build a dataset's WRITE CONTRACT from the collection document the server
 * returns on GET /api/data/collections/:id.
 *
 * This is the piece an agent reads before writing a collector script, so it is
 * written from the PRODUCER's point of view — what keys to emit, in what form,
 * keyed on what — rather than describing the storage schema. Everything here is
 * derived; the server has no /schema endpoint, which keeps this wording (really
 * prompt engineering for the consuming agent) iterating at CLI speed.
 *
 * Pure: no I/O, no dependencies, so it is unit-testable and so `create`,
 * `schema`, and `sync`'s preflight all derive identical facts.
 *
 * Sources:
 *   requiredKeys   ← source.importAdapter.workbookFingerprint.sheets[]
 *   field mappings ← source.entities[i].fields[]   (name, sourceColumn, type=transform)
 *   primary key    ← source.entities[i].config.primaryKeyColumn  (a TARGET field
 *                    name — mapped back to its source key here, because emitting
 *                    the target name is the easiest mistake to make)
 *   canonical types← source.entityAdapter.entities[].fields[].type
 */

const WRITE_RULES = [
  'Emit the COMPLETE dataset on every run — never a delta, never an append-only chunk.',
  'Rows present in a previous sync but absent from this payload are permanently deleted.',
  'Row identity is the primary key, NOT array position. Rows may be reordered freely.',
  "The primary key value is the row's PERMANENT identity. Changing it destroys any comments or files attached to that row, with no way to recover them.",
  'Key names must match EXACTLY (case-sensitive).',
  'Extra keys are ignored, not an error. Missing keys fail the sync.',
  'Max payload 50 MB.',
];

const PK_STABILITY_RULE =
  "This value IS the row's identity — the app derives each row's comment/file thread id from it. "
  + 'Once a row is synced with a given primary key, that value must never change. Use a natural key '
  + 'from your data source (an upstream record id, a canonical slug). NEVER use an array index, a row '
  + 'number, a collection timestamp, or a hash of mutable fields — those rotate on every run and would '
  + 'orphan every attached thread nightly. Emit it as a string in its exact final form: identity is '
  + 'String(value), so 1234 and "01234" are different rows.';

/**
 * How to write each field, from its canonical type plus the transform the
 * adapter will apply. Types alone are not enough — "number" does not stop a
 * model emitting "$1,200", but the explicit phrasing does.
 */
function writeAsFor(canonicalType, transform) {
  switch (canonicalType) {
    case 'number':
      return 'JSON number, or null when unknown. Not a formatted string — no currency symbol, no thousands separator, no percent sign.';
    case 'boolean':
      return 'JSON true or false (not the strings "true"/"false").';
    case 'date':
      return 'ISO 8601 date string, e.g. "2026-07-20". Use null when unknown, never an empty string.';
    case 'stringArray':
      return transform === 'split_slash'
        ? 'JSON array of strings, e.g. ["a","b"]. A "/"-joined string is also accepted.'
        : 'JSON array of strings, e.g. ["a","b"]. A comma-joined string is also accepted.';
    case 'objectIdArray':
      return 'JSON array of primary-key values from the related entity.';
    case 'mixed':
      return 'any JSON value.';
    case 'string':
    default:
      return 'plain text string, or null when unknown.';
  }
}

const TRANSFORM_TO_CANONICAL = {
  number: 'number', integer: 'number',
  boolean: 'boolean', boolean_x: 'boolean', boolean_truthy: 'boolean',
  date: 'date', date_iso: 'date', date_swedish: 'date',
  split_slash: 'stringArray', split_comma: 'stringArray',
};

/** Mirror of the server's canonicalTypeFromTransform, for the fallback path. */
function canonicalFromTransform(transform) {
  if (!transform) return 'string';
  return TRANSFORM_TO_CANONICAL[String(transform).toLowerCase()] || 'string';
}

function resolveSource(collection, sourceIndex) {
  const sources = collection?.sources || [];
  if (sources.length === 0) {
    return { error: 'this dataset has no sources' };
  }
  if (sourceIndex !== undefined && sourceIndex !== null) {
    const si = Number(sourceIndex);
    if (!Number.isInteger(si) || si < 0 || si >= sources.length) {
      return { error: `--source ${sourceIndex} is out of range (0..${sources.length - 1})` };
    }
    return { source: sources[si], si };
  }
  if (sources.length > 1) {
    const listed = sources.map((s, i) => `  [${i}] ${s.provider}${s.connectionName ? ` — ${s.connectionName}` : ''}`).join('\n');
    return { error: `this dataset has ${sources.length} sources — pass --source <i>:\n${listed}` };
  }
  return { source: sources[0], si: 0 };
}

/**
 * Build the contract for one source of a dataset.
 * Returns `{ error }` when the source can't be resolved, else the contract.
 */
function buildContract(collection, { sourceIndex } = {}) {
  const resolved = resolveSource(collection, sourceIndex);
  if (resolved.error) return { error: resolved.error };
  const { source, si } = resolved;

  const collectionId = collection.collectionId || collection.id;
  const warnings = [];

  const fingerprintSheets = source.importAdapter?.workbookFingerprint?.sheets || [];
  const entityAdapterEntities = source.entityAdapter?.entities || [];
  const sourceEntities = source.entities || [];

  // A source with no entityAdapter silently degrades to the legacy flattened
  // store, which generated apps do not read. Worth surfacing loudly.
  if (!source.entityAdapter) {
    warnings.push({
      code: 'no_entity_adapter',
      message: 'This source has no entityAdapter — it falls back to the legacy store, which built '
        + 'apps do not read. Recreate the dataset.',
    });
  }

  const entities = sourceEntities.map((entity, ei) => {
    const logicalName = entity.config?.collectionLogicalName || entity.displayName;
    const adapterEntity = entityAdapterEntities.find((e) => e.entityName === logicalName)
      || entityAdapterEntities[ei]
      || null;
    const canonicalByName = new Map(
      (adapterEntity?.fields || []).map((f) => [f.name, f]),
    );

    const pkField = entity.config?.primaryKeyColumn || null;
    const fields = (entity.fields || []).map((f) => {
      const canonical = canonicalByName.get(f.name);
      // entity.fields[].type is the TRANSFORM name, not a canonical type —
      // prefer the entityAdapter's real type when present.
      const type = canonical?.type || canonicalFromTransform(f.type);
      return {
        key: f.sourceColumn || null,
        field: f.name,
        type,
        transform: f.type || 'identity',
        required: !!f.required,
        primaryKey: !!pkField && f.name === pkField,
        ...(f.refTarget ? { referencesEntity: f.refTarget } : {}),
        writeAs: writeAsFor(type, f.type),
      };
    });

    const pkEntry = fields.find((f) => f.primaryKey) || null;
    const primaryKey = pkField
      ? {
        field: pkField,
        sourceKey: pkEntry?.key || null,
        kind: pkEntry?.key ? 'column' : 'derived',
        rule: 'Must be non-empty and unique across the whole payload. Two rows with the same value collapse into one.',
        stability: 'IMMUTABLE',
        stabilityRule: PK_STABILITY_RULE,
      }
      : null;

    if (!pkField) {
      warnings.push({
        code: 'entity_without_primary_key',
        entity: entity.displayName,
        message: `Entity "${entity.displayName}" has no primary key column, so it can never be `
          + 'synced. The dataset must be recreated.',
      });
    } else if (!pkEntry?.key) {
      warnings.push({
        code: 'primary_key_not_a_source_column',
        entity: entity.displayName,
        message: `Entity "${entity.displayName}" keys on "${pkField}", which is derived (a template `
          + 'or constant) rather than a single input key. Reproduce its inputs exactly.',
      });
    }

    return {
      sourceKey: `s${si}_e${ei}`,
      displayName: entity.displayName,
      sheets: entity.config?.sheets || (entity.config?.sheetName ? [entity.config.sheetName] : []),
      primaryKey,
      fields,
    };
  });

  // requiredKeys is the union across sheets — for the common single-entity
  // dataset that is just "the keys to emit", which is the question being asked.
  const requiredKeys = [];
  const seenKey = new Set();
  for (const sheet of fingerprintSheets) {
    for (const h of sheet.headers || []) {
      if (!seenKey.has(h)) { seenKey.add(h); requiredKeys.push(h); }
    }
  }

  const sheetNames = fingerprintSheets.map((s) => s.name);
  const singleSheet = fingerprintSheets.length === 1;
  const syncable = source.provider === 'file-upload'
    && !!source.importAdapter?.seedPlan
    && !!source.entityAdapter
    && entities.length > 0
    && entities.every((e) => e.primaryKey);

  return {
    collectionId,
    name: collection.name,
    sourceIndex: si,
    provider: source.provider,
    syncable,
    syncCommand: syncable
      ? `gaia dataset sync ${collectionId} -`
      : null,

    writeContract: {
      semantics: 'full-snapshot',
      summary: 'Every sync replaces the ENTIRE dataset. Emit every row you want to exist, every '
        + 'time. Rows absent from the payload are DELETED server-side.',
      rules: WRITE_RULES,
    },

    shape: {
      transport: 'json',
      accepts: singleSheet
        ? ['[ {...}, {...} ]', '{ "sheets": { "<name>": [ {...} ] } }']
        : ['{ "sheets": { "<name>": [ {...} ] } }'],
      requiredKeys,
      keyMatch: 'exact',
      keyOrderMatters: false,
      extraKeysAllowed: true,
      ...(singleSheet ? {} : { sheetNames }),
      alsoAcceptsFile: {
        extensions: ['.csv', '.xlsx', '.xls'],
        sheetNames,
        // A CSV always parses as one sheet named "Sheet1", so it is only a
        // drop-in alternative when that is what this dataset expects.
        csvCompatible: singleSheet && sheetNames[0] === 'Sheet1',
        ...(singleSheet && sheetNames[0] !== 'Sheet1'
          ? {
            csvNote: `A CSV always parses as a single sheet named "Sheet1", but this dataset `
              + `expects "${sheetNames[0]}". Use JSON, or an .xlsx with that sheet name.`,
          }
          : {}),
      },
    },

    entities,
    warnings,
  };
}

module.exports = { buildContract, writeAsFor, canonicalFromTransform };
