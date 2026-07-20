const http = require('../http');
const session = require('../importSession');
const rowsInput = require('../rowsInput');
const { buildContract } = require('../datasetContract');
const { fail } = require('../util');

// The PK-overlap guard compares against existing keys read back from the
// server. /records paginates and returns full row bodies, so the read is
// bounded: at most CAP keys over pages of PAGE. For the dataset sizes an agent
// builds this is exact; above the cap it degrades to a large sample, which is
// still conclusive for the failure it exists to catch (wholesale rotation or a
// truncated payload). When it samples, the message says so.
const GUARD_PAGE = 500;
const GUARD_CAP = 2000;

function out(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function err(line) {
  process.stderr.write(line + '\n');
}

async function fetchCollection(id) {
  const res = await http.get(`/api/data/collections/${encodeURIComponent(id)}`);
  const collection = res?.collection || res;
  if (!collection?.sources) throw fail(`unexpected response for dataset ${id}`, 1);
  return collection;
}

function contractOrFail(collection, sourceIndex) {
  const contract = buildContract(collection, { sourceIndex });
  if (contract.error) throw fail(contract.error);
  return contract;
}

/**
 * Read existing primary-key values for one entity. Returns
 * `{ keys:Set<string>, total:number, sampled:boolean }`.
 */
async function fetchExistingKeys(collectionId, sourceKey) {
  const base = `/api/data/collections/${encodeURIComponent(collectionId)}/records`
    + `?sourceKey=${encodeURIComponent(sourceKey)}`;
  const probe = await http.get(`${base}&limit=1`);
  const total = probe?.pagination?.total ?? 0;
  const keys = new Set();
  if (total === 0) return { keys, total: 0, sampled: false };

  const want = Math.min(total, GUARD_CAP);
  for (let skip = 0; skip < want; skip += GUARD_PAGE) {
    const page = await http.get(`${base}&limit=${GUARD_PAGE}&skip=${skip}`);
    for (const r of page?.records || []) {
      if (r.sourceId !== undefined && r.sourceId !== null) keys.add(String(r.sourceId));
    }
    if (!page?.pagination?.hasMore) break;
  }
  return { keys, total, sampled: want < total };
}

/**
 * Refuse a sync whose primary keys barely overlap what is already stored.
 *
 * This is the guard that matters, and it is deliberately about KEYS rather than
 * row count. A typed doc's _id derives from its primary key value, and the app
 * derives each row's comment/file thread id from that _id — so a payload that
 * renames or regenerates keys silently deletes every existing row and recreates
 * it with a fresh identity, orphaning all attached collaboration data. A
 * regenerated key with an unchanged row count looks perfectly healthy to any
 * size-based check; only key continuity catches it.
 *
 * A truncated payload (collector crashed mid-run) fails the same test, so this
 * subsumes a row-count guard rather than needing one alongside.
 */
async function assertKeyOverlap({ collectionId, contract, payload, minOverlap, force }) {
  if (minOverlap <= 0 || force) return null;

  const entity = contract.entities[0];
  const pkSourceKey = entity?.primaryKey?.sourceKey;
  if (!pkSourceKey) return null; // derived key — nothing to compare against

  const incoming = rowsInput.primaryKeyValues(payload, pkSourceKey);
  if (incoming.size === 0) {
    throw fail(
      `no values found for the primary key "${pkSourceKey}" in the payload. `
      + `Run \`gaia dataset schema ${collectionId}\` for the exact keys to emit.`,
    );
  }

  const { keys: existing, total, sampled } = await fetchExistingKeys(collectionId, entity.sourceKey);
  if (existing.size === 0) return null; // first sync — nothing to protect

  let survivors = 0;
  for (const k of existing) if (incoming.has(k)) survivors++;
  const overlap = survivors / existing.size;
  if (overlap >= minOverlap) return { overlap, survivors, existing: existing.size, total };

  const lost = existing.size - survivors;
  err(`error: this payload would replace ${lost} of ${existing.size} existing rows with new identities — refusing.`);
  err('');
  err(`  Only ${survivors} of ${existing.size} existing primary keys ("${pkSourceKey}") appear in the payload${sampled ? ` (sampled ${existing.size} of ${total})` : ''}.`);
  err('  That is the signature of a rotated or regenerated primary key, not new data.');
  err(`  Syncing would delete ${lost} rows and recreate them fresh, permanently orphaning`);
  err('  any comments or files attached to them.');
  err('');
  err('  If the primary key genuinely changed, create a new dataset instead.');
  err('  If this is intentional data turnover, re-run with --force.');
  const e = fail('primary-key overlap below threshold', 3);
  e.reported = true;
  throw e;
}

/** Explain a drift response in terms the caller can act on. */
function reportDrift(collectionId, drift, inputKind, contract) {
  err('error: the payload no longer matches this dataset\'s shape — nothing was synced.');
  err('');
  for (const d of drift) {
    if (d.kind === 'missing_sheet') {
      err(`  missing sheet "${d.sheet}"`);
      if (inputKind === 'spreadsheet' && d.sheet !== 'Sheet1') {
        err('    → you uploaded a .csv, which ALWAYS parses as a single sheet named "Sheet1".');
        err(`      This dataset requires a sheet named "${d.sheet}" — send JSON, or an .xlsx with that sheet name.`);
      } else {
        err(`    → send { "sheets": { "${d.sheet}": [...] } }`);
      }
    } else if (d.kind === 'missing_columns') {
      err(`  sheet "${d.sheet}" is missing keys: ${(d.columns || []).join(', ')}`);
      err('    → key names must match exactly (case-sensitive).');
      err(`      Expected: ${contract.shape.requiredKeys.join(', ')}`);
    } else {
      err(`  ${JSON.stringify(d)}`);
    }
  }
  err('');
  err(`Run \`gaia dataset schema ${collectionId}\` for the exact contract.`);
  err("A dataset's shape is fixed at creation — to change keys, create a new dataset.");
}

/** Normalize the two server sync shapes into one. */
function normalizeSyncResult({ collectionId, method, sourceIndex, provider, body }) {
  const sr = body.syncResult || body;
  const entities = (sr.entities || []).map((e) => ({
    sourceKey: e.sourceKey,
    displayName: e.displayName,
    recordCount: e.recordCount ?? 0,
    stats: {
      inserted: e.stats?.inserted ?? 0,
      updated: e.stats?.updated ?? 0,
      deleted: e.stats?.deleted ?? 0,
    },
  }));
  return {
    ok: true,
    collectionId,
    method,
    sourceIndex,
    provider,
    syncedAt: sr.syncedAt || null,
    totalRecords: sr.totalRecords ?? null,
    entities,
  };
}

/**
 * Finalize a proposal-state analyzer session and create the dataset from it.
 * Shared by `create` and `answer`, since either can be the command that first
 * observes `state === 'proposal'`.
 */
async function completeCreate({ importSessionId, intent }) {
  err('→ finalizing analysis…');
  const finalized = await session.finalizeSession(importSessionId);
  const validation = finalized?.validation;
  if (validation?.warnings?.length) {
    for (const w of validation.warnings) {
      err(`  ! ${w.code || 'warning'}: ${w.message || w}`);
    }
  }

  const name = intent?.name
    || (finalized?.fileName || '').replace(/\.(xlsx|xls|csv|json)$/i, '').trim()
    || 'Imported Data';
  err(`→ creating dataset "${name}"…`);
  const created = await session.createCollectionFromSession({
    importSessionId,
    name,
    description: intent?.description,
  });

  session.saveState({
    state: 'dataset-created',
    collectionId: created.collectionId,
    datasetName: created.name,
    importSessionId,
    savedAt: new Date().toISOString(),
  });

  // Re-read so the contract is built from what was actually persisted, not
  // from what we think we sent — this is where a failed entityAdapter build
  // or a missing primary key surfaces.
  const collection = await fetchCollection(created.collectionId);
  const contract = buildContract(collection);

  err(`  ✓ dataset ${created.collectionId} (${created.collection?.stats?.totalRecords ?? '?'} rows)`);
  for (const w of contract.warnings || []) err(`  ! ${w.message}`);
  if (contract.syncable) {
    err('');
    err('Sync it on every collector run with:');
    err(`  ${contract.syncCommand}`);
  }

  out({
    ok: true,
    collectionId: created.collectionId,
    name: created.name,
    stats: created.collection?.stats || null,
    syncable: contract.syncable,
    warnings: contract.warnings,
    contract,
  });
}

/** Turn a question-state response into the documented exit-2 protocol. */
function reportQuestion(data) {
  out(data);
  process.exit(2);
}

module.exports = (program) => {
  const dataset = program
    .command('dataset')
    .description('Create and sync Gainable datasets from JSON rows or spreadsheets');

  // ── list ────────────────────────────────────────────────────────────────
  dataset
    .command('list')
    .description('List datasets with their sync method and row counts')
    .option('-q, --query <text>', 'filter by name')
    .action(async (opts) => {
      const res = await http.get('/api/data/collections?slim=1');
      const all = res?.collections || res || [];
      const q = (opts.query || '').toLowerCase();
      const rows = all
        .filter((c) => !q || String(c.name || '').toLowerCase().includes(q))
        .map((c) => ({
          collectionId: c.collectionId || c.id,
          name: c.name,
          providers: (c.sources || []).map((s) => s.provider),
          entityCount: (c.sources || []).reduce((n, s) => n + (s.entities?.length || 0), 0),
          totalRecords: c.stats?.totalRecords ?? null,
          lastSyncAt: c.stats?.lastSyncAt || null,
        }));
      out({ ok: true, count: rows.length, datasets: rows });
    });

  // ── schema ──────────────────────────────────────────────────────────────
  dataset
    .command('schema <id>')
    .description('Print the dataset\'s write contract — read this BEFORE writing a collector script')
    .option('--source <i>', 'which source (multi-source datasets)')
    .option('--raw', 'dump the untouched sources[] instead (debugging)')
    .action(async (id, opts) => {
      const collection = await fetchCollection(id);
      if (opts.raw) {
        out({ collectionId: collection.collectionId || collection.id, sources: collection.sources });
        return;
      }
      const contract = contractOrFail(collection, opts.source);
      for (const w of contract.warnings || []) err(`! ${w.message}`);
      if (!contract.syncable && contract.provider === 'file-upload') {
        err('! This dataset cannot be synced — see warnings above.');
      }
      out(contract);
    });

  // ── sync ────────────────────────────────────────────────────────────────
  dataset
    .command('sync <id> [input]')
    .description('Replace the dataset contents with a full snapshot (\'-\' for JSON on stdin)')
    .option('--source <i>', 'which source (multi-source datasets)')
    .option('--min-overlap <pct>', 'refuse if fewer than this fraction of existing primary keys survive (default 0.5)', '0.5')
    .option('--force', 'skip the primary-key overlap guard')
    .action(async (id, input, opts) => {
      const collection = await fetchCollection(id);
      const contract = contractOrFail(collection, opts.source);
      const { sourceIndex, provider } = contract;

      // Non-file sources re-fetch from upstream; there is nothing to send.
      if (provider !== 'file-upload') {
        if (input) {
          throw fail(
            `this dataset's source is "${provider}", which re-fetches from upstream — `
            + 'it takes no input. Run `gaia dataset sync <id>` with no argument.',
          );
        }
        err(`→ syncing ${provider} source (re-fetching from upstream)…`);
        const body = await http.post(
          `/api/data/collections/${encodeURIComponent(id)}/sync?sourceIndex=${sourceIndex}&mode=full`,
        );
        const result = normalizeSyncResult({
          collectionId: contract.collectionId, method: 'upstream-sync', sourceIndex, provider, body,
        });
        for (const e of result.entities) {
          err(`  ✓ ${e.displayName}: ${e.recordCount} rows (+${e.stats.inserted} ~${e.stats.updated} -${e.stats.deleted})`);
        }
        out(result);
        return;
      }

      if (!contract.syncable) {
        for (const w of contract.warnings || []) err(`! ${w.message}`);
        throw fail('this dataset cannot be synced — see the warnings above');
      }
      if (!input) {
        throw fail(
          'this dataset syncs from data you supply — pass \'-\' to read JSON from stdin, '
          + `or a path to a .json/.csv/.xlsx file. Run \`gaia dataset schema ${contract.collectionId}\` `
          + 'for the exact shape to emit.',
        );
      }

      const spec = rowsInput.classifyInput(input);
      const buffer = rowsInput.readInput(spec);
      const minOverlap = Number(opts.minOverlap);
      if (!Number.isFinite(minOverlap) || minOverlap < 0 || minOverlap > 1) {
        throw fail('--min-overlap must be between 0 and 1');
      }

      let body;
      if (spec.kind === 'json') {
        const payload = rowsInput.parseJsonRows(buffer, input);
        const rowCount = rowsInput.countRows(payload);
        err(`→ syncing ${rowCount} row(s) as JSON…`);

        const guard = await assertKeyOverlap({
          collectionId: contract.collectionId, contract, payload, minOverlap, force: opts.force,
        });
        if (guard) {
          err(`  key overlap ${(guard.overlap * 100).toFixed(0)}% (${guard.survivors}/${guard.existing} existing keys retained)`);
        }

        const reqBody = payload.sheets ? { sheets: payload.sheets } : { rows: payload.rows };
        reqBody.fileName = spec.fileName;
        body = await http.post(
          `/api/data/collections/${encodeURIComponent(id)}/sources/${sourceIndex}/ingest`,
          reqBody,
        );
      } else {
        // Spreadsheet path: no client-side parser (the CLI has one dependency
        // on purpose), so the overlap guard can't run pre-flight here. Warn
        // after the fact instead — it can't prevent, but it makes an otherwise
        // silent mass-delete visible.
        err(`→ syncing ${spec.fileName} (${buffer.length} bytes) as a spreadsheet…`);
        if (!opts.force) {
          err('  note: the primary-key overlap guard only runs pre-flight for JSON input.');
        }
        body = await http.postMultipart(
          `/api/data/collections/${encodeURIComponent(id)}/sources/${sourceIndex}/reupload-file`,
          { buffer, fileName: spec.fileName },
        );
      }

      // Drift comes back as HTTP 200 with ok:false, so http.js does not throw.
      if (body && body.ok === false && body.drift) {
        reportDrift(contract.collectionId, body.drift, spec.kind, contract);
        out({ ok: false, collectionId: contract.collectionId, reason: 'drift', drift: body.drift });
        process.exit(3);
      }

      const result = normalizeSyncResult({
        collectionId: contract.collectionId,
        method: spec.kind === 'json' ? 'ingest' : 'reupload-file',
        sourceIndex, provider, body,
      });
      let deleted = 0;
      for (const e of result.entities) {
        deleted += e.stats.deleted;
        err(`  ✓ ${e.displayName}: ${e.recordCount} rows (+${e.stats.inserted} ~${e.stats.updated} -${e.stats.deleted})`);
      }
      if (deleted > 0 && spec.kind === 'spreadsheet') {
        err(`  ! ${deleted} row(s) were deleted. If that was not intended, they are gone along with`);
        err('    any comments or files attached to them.');
      }
      out(result);
    });

  // ── create ──────────────────────────────────────────────────────────────
  dataset
    .command('create <input>')
    .description('Create a dataset from JSON rows or a spreadsheet (\'-\' for JSON on stdin)')
    .option('--name <name>', 'dataset name (default: derived from the input file name)')
    .option('--description <text>', 'dataset description')
    .option('--sheet-name <name>', 'sheet name to record for JSON input (default: Sheet1)')
    .action(async (input, opts) => {
      const spec = rowsInput.classifyInput(input);
      const buffer = rowsInput.readInput(spec);
      const name = opts.name
        || (spec.fileName || '').replace(/\.(xlsx|xls|csv|json)$/i, '').trim()
        || 'Imported Data';
      const intent = { kind: 'dataset-create', name, description: opts.description || null };

      let data;
      if (spec.kind === 'json') {
        const payload = rowsInput.parseJsonRows(buffer, input);
        const rowCount = rowsInput.countRows(payload);
        if (rowCount === 0) throw fail('no rows in the input');
        if (rowCount < 5) {
          err(`! only ${rowCount} row(s) supplied. The analyzer infers column types and picks the`);
          err('  primary key from real values, and that choice is frozen for the dataset\'s life —');
          err('  seed with 5-20 representative rows for a good schema.');
        }
        err(`→ analyzing ${rowCount} row(s)…`);
        data = await session.startRowsSession({
          rows: payload.rows,
          sheets: payload.sheets,
          sheetName: opts.sheetName,
          fileName: spec.fileName,
        });
      } else {
        err(`→ uploading ${spec.fileName} (${buffer.length} bytes)…`);
        data = await session.startFileSession({ buffer, fileName: spec.fileName });
      }

      session.persistTurnResponse(data, { intent });

      if (data.state === 'question') return reportQuestion(data);
      if (data.state === 'proposal') {
        return completeCreate({ importSessionId: data.importSessionId, intent });
      }
      out(data);
    });

  // ── answer ──────────────────────────────────────────────────────────────
  dataset
    .command('answer <answers>')
    .description('Answer the analyzer\'s pending question; completes the dataset when it proposes')
    .option('--session <id>', 'override session')
    .option('--tool-use-id <id>', 'override toolUseId')
    .action(async (answersRaw, opts) => {
      const local = session.loadState();
      const importSessionId = opts.session || local?.importSessionId;
      if (!importSessionId) {
        throw fail('no active session — run `gaia dataset create <input>` first');
      }
      const toolUseId = opts.toolUseId || local?.toolUseId;
      if (!toolUseId) throw fail('no pending question for this session');

      let answers;
      try { answers = JSON.parse(answersRaw); }
      catch (e) { throw fail(`<answers> must be valid JSON: ${e.message}`); }

      let data;
      try {
        data = await session.answerTurn({ importSessionId, toolUseId, answers });
      } catch (e) {
        if (session.isSessionGone(e)) {
          session.clearState();
          throw fail('the analyzer session expired — re-run `gaia dataset create <input>`');
        }
        throw e;
      }

      session.persistTurnResponse(data);
      if (data.state === 'question') return reportQuestion(data);
      if (data.state === 'proposal') {
        return completeCreate({ importSessionId, intent: local?.intent });
      }
      out(data);
    });
};
