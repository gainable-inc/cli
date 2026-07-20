const fs = require('fs');
const path = require('path');
const http = require('../http');
const credentials = require('../credentials');
const project = require('../project');
const { fail } = require('../util');
const session = require('../importSession');

// Session state + analyzer transport live in ../importSession so `gaia import`
// and `gaia dataset` drive the identical protocol against one implementation.
const {
  STATE_FILE,
  stateLocation,
  saveState,
  loadState,
  clearState,
  persistTurnResponse,
} = session;

function resolveSessionId(flag) {
  if (flag) return flag;
  const s = loadState();
  if (s?.importSessionId) return s.importSessionId;
  throw fail('no active import session — pass --session <id> or run `gaia import upload <file>` first');
}

module.exports = (program) => {
  const importCmd = program
    .command('import')
    .description('Upload a spreadsheet and walk the ImportAgent question flow');

  importCmd
    .command('upload <file>')
    .description('Upload an xlsx/xls/csv file and run the first agent turn')
    .action(async (file) => {
      const abs = path.resolve(file);
      if (!fs.existsSync(abs)) throw fail(`file not found: ${abs}`);
      const buffer = fs.readFileSync(abs);
      const name = path.basename(abs);

      process.stderr.write(`→ uploading ${name} (${buffer.length} bytes)\n`);
      const parsed = await session.startFileSession({ buffer, fileName: name });

      persistTurnResponse(parsed);
      process.stdout.write(JSON.stringify(parsed, null, 2) + '\n');
      if (parsed.state === 'question') process.exit(2);
    });

  importCmd
    .command('state')
    .description('Peek the current import session WITHOUT advancing the agent')
    .option('--session <id>', 'override session (default: last from local state)')
    .action(async (opts) => {
      const id = resolveSessionId(opts.session);
      const data = await session.getSessionState(id);
      persistTurnResponse(data);
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      if (data.state === 'question') process.exit(2);
    });

  importCmd
    .command('answer <answers>')
    .description('Submit answers JSON to the agent\'s pending question (toolUseId from local state)')
    .option('--session <id>', 'override session')
    .option('--tool-use-id <id>', 'override toolUseId')
    .action(async (answersRaw, opts) => {
      const importSessionId = resolveSessionId(opts.session);
      const local = loadState();
      const toolUseId = opts.toolUseId || local?.toolUseId;
      if (!toolUseId) throw fail('no pending question — run `gaia import state` first');
      let answers;
      try { answers = JSON.parse(answersRaw); }
      catch (err) { throw fail(`<answers> must be valid JSON: ${err.message}`); }

      const data = await session.answerTurn({ importSessionId, toolUseId, answers });
      persistTurnResponse(data);
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
      if (data.state === 'question') process.exit(2);
    });

  importCmd
    .command('finalize')
    .description('Validate the proposed seedPlan and return the importAdapter')
    .option('--session <id>', 'override session')
    .action(async (opts) => {
      const importSessionId = resolveSessionId(opts.session);
      const data = await session.finalizeSession(importSessionId);
      // finalize doesn't change the asked-question state; just write the
      // proposal-ready snapshot so callers can re-read it.
      saveState({
        importSessionId,
        fileName: data.fileName || null,
        state: 'finalized',
        toolUseId: null,
        question: null,
        adapter: data.importAdapter || null,
        savedAt: new Date().toISOString()
      });
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    });

  importCmd
    .command('cancel')
    .description('Drop the import session server-side and clear local state')
    .option('--session <id>', 'override session')
    .action(async (opts) => {
      const importSessionId = resolveSessionId(opts.session);
      const data = await session.cancelSession(importSessionId);
      clearState();
      process.stdout.write(JSON.stringify({ ...data, importSessionId }) + '\n');
    });

  // The bridge from a finalized import session into the build journey —
  // mirrors what the web wizard does after the analyzer dialog resolves:
  //   1. POST /api/data/collections with the session id → dataset created,
  //      rows ingested (this CONSUMES the in-memory session)
  //   2. ensure a project exists (auto-create + write .gaia/ when missing,
  //      same as `gaia build "<idea>"` auto-init)
  //   3. POST /api/projects/:id/attach-import-collection → mains
  //      materialized into the draft contract
  // After this, the normal `gaia build` contract loop takes over.
  //
  // Re-runnable: the created collectionId is persisted to local state
  // before the attach call, so a failure between steps resumes where it
  // left off instead of erroring on the consumed session.
  importCmd
    .command('attach')
    .description('Create the dataset from the finalized session and attach it to a project (auto-creates the project when no .gaia/ exists)')
    .option('--session <id>', 'override import session')
    .option('--collection <id>', 'attach an existing dataset instead of creating one from the session')
    .option('--name <datasetName>', 'dataset name (default: uploaded file name without extension)')
    .option('--project <id>', 'attach to this project (skips .gaia/ discovery and auto-create)')
    .option('--project-name <name>', 'name for an auto-created project (default: dataset name)')
    .action(async (opts) => {
      const local = loadState();

      // ── Step 1: resolve or create the dataset ──────────────────────
      let collectionId = opts.collection || local?.collectionId || null;
      let datasetName = opts.name || null;
      if (!collectionId) {
        const importSessionId = resolveSessionId(opts.session);
        if (!datasetName) {
          const stem = (local?.fileName || '').replace(/\.(xlsx|xls|csv)$/i, '').trim();
          datasetName = stem || 'Imported Data';
        }
        process.stderr.write(`→ creating dataset "${datasetName}" from session ${importSessionId}\n`);
        const created = await session.createCollectionFromSession({
          importSessionId,
          name: datasetName
        });
        collectionId = created.collectionId;
        datasetName = created.name;
        // The session is consumed now — persist the collectionId so a
        // retry after a downstream failure skips re-creation.
        saveState({
          ...(local || {}),
          state: 'dataset-created',
          collectionId,
          datasetName,
          toolUseId: null,
          question: null,
          savedAt: new Date().toISOString()
        });
        process.stderr.write(`  ✓ dataset ${collectionId} (${created.collection.stats?.totalRecords ?? '?'} rows)\n`);
      } else {
        process.stderr.write(`→ reusing dataset ${collectionId}\n`);
      }

      // ── Step 2: resolve or create the project ──────────────────────
      let ctx;
      try {
        ctx = project.resolveProject({ projectIdOverride: opts.project });
      } catch {
        const projectName = opts.projectName
          || datasetName
          || (local?.fileName || '').replace(/\.(xlsx|xls|csv)$/i, '').trim()
          || 'Imported Data';
        process.stderr.write(`→ no .gaia/ here — creating project "${projectName}"…\n`);
        const created = await http.post('/api/projects', { projectName });
        if (!created?.projectId) throw fail('project create failed — no projectId in response', 1);
        ctx = project.writeProjectFiles({
          projectId: created.projectId,
          projectName: created.projectName,
          apiBase: credentials.load().apiBase,
        });
        process.stderr.write(`  + .gaia/project.json (id=${created.projectId})\n`);
        // .gaia/ exists now, so stateLocation() resolves there — re-persist
        // the in-flight snapshot so a retry after an attach failure finds
        // the collectionId (the import session is already consumed).
        saveState({
          ...(local || {}),
          state: 'dataset-created',
          collectionId,
          datasetName: datasetName || null,
          toolUseId: null,
          question: null,
          savedAt: new Date().toISOString()
        });
      }

      // ── Step 3: attach (idempotent server-side) ─────────────────────
      const data = await http.post(
        `/api/projects/${encodeURIComponent(ctx.projectId)}/attach-import-collection`,
        { collectionId }
      );

      // State may have lived in ~/.gainable/ when the upload happened in
      // an empty dir; now that .gaia/ exists, stateLocation() resolves
      // there. Write the terminal snapshot and clear the stale global
      // copy so a later import in another empty dir can't pick it up.
      const globalFile = path.join(path.dirname(credentials.CREDENTIALS_PATH), STATE_FILE);
      saveState({
        state: 'attached',
        collectionId,
        datasetName: datasetName || null,
        projectId: ctx.projectId,
        importSessionId: local?.importSessionId || null,
        fileName: local?.fileName || null,
        savedAt: new Date().toISOString()
      });
      const { file: currentFile } = stateLocation();
      if (currentFile !== globalFile) {
        try { fs.unlinkSync(globalFile); } catch { /* never existed */ }
      }

      process.stderr.write(
        `✓ attached — continue with:\n` +
        `  gaia build --silent "Let's get started. Analyze the attached data and propose an initial contract."\n`
      );
      process.stdout.write(JSON.stringify({
        ok: true,
        projectId: ctx.projectId,
        collectionId,
        attachedCollections: data.attachedCollections || [],
      }, null, 2) + '\n');
    });
};
