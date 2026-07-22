const http = require('../http');
const credentials = require('../credentials');
const project = require('../project');
const { fail } = require('../util');

/**
 * gaia chat — refine an already-built app via the BuildAgent.
 *
 *   gaia chat "add a probability column to the deals table"
 *   gaia chat --page deals "rename the Stage column to Pipeline Stage"
 *
 * Each call is one turn. The server runs the same planner → plan →
 * executor pipeline the web UI runs, auto-accepting the plan (no human-
 * approval step in the CLI flow — Claude already decided to make this
 * call). Progress streams via SSE from the same bus that powers the
 * build event stream.
 *
 * Exit codes:
 *   0 — completion_ready / workflow_complete (success)
 *   1 — transport error
 *   2 — planner_clarification (user owes a reply; just run `gaia chat`
 *       again with their answer — the server detects the pending
 *       clarification and merges the answer in)
 *   3 — agent_error / workflow_stage_failed / workflow_abandoned /
 *       validation / auth
 *   4 — a turn is already running for this project. NOT a failure and NOT
 *       retryable: the server refused a second turn precisely so the same
 *       message doesn't get posted twice. Wait for the running turn.
 *
 * Turn scoping: the refine POST returns a `cursor` (the event bus's
 * high-water mark at the moment the turn was accepted) and the SSE
 * subscription passes it back as ?after=. Without it the server replays a
 * wall-clock window, which can still contain the PREVIOUS turn's terminal
 * event — the CLI would then print that turn's summary and exit 0 before
 * this turn's planner had run (trace 2026-07-22).
 *
 * Multi-stage refines: when the planner decomposes a request into several
 * build stages (a "workflow"), the server auto-accepts and runs them — the
 * CLI streams workflow_stage_* progress and terminates on workflow_complete.
 * No manual "Build All" click is required in this headless flow.
 */

async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        let eventName = 'message';
        const dataLines = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) continue;
        let payload;
        try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
        yield { eventName, payload };
      }
    }
  } finally {
    // Leaving the stream early (terminal event → `break`) parks a pending
    // read on the fetch body. Calling process.exit() on top of that tears
    // the loop down while the socket handle is mid-close, which trips a
    // libuv assertion on Windows —
    //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
    //   file src\win\async.c, line 76
    // — so the CLI printed "✓ done" and then crashed with a non-zero
    // status, and the calling agent read the crash as a failed turn and
    // retried (trace 2026-07-22). `break` runs this finally before we
    // exit, so the body is released first.
    try { await reader.cancel(); } catch { /* stream already torn down */ }
  }
}

module.exports = (program) => {
  program
    .command('chat')
    .description('Refine an already-built app: send a message to the BuildAgent and stream progress')
    .argument('<message>', 'what to change in the app')
    .option('--project <id>', 'override project context')
    .option('--page <slug>', 'target a specific view (defaults to the project\'s root view)')
    .action(async (message, opts) => {
      const ctx = project.resolveProject({ projectIdOverride: opts.project });

      const body = { message };
      if (opts.page) body.pageSlug = opts.page;

      process.stderr.write(`→ refine: ${ctx.projectId}${opts.page ? ` (page: ${opts.page})` : ''}\n`);
      let started;
      try {
        started = await http.post(`/api/projects/${encodeURIComponent(ctx.projectId)}/refine`, body);
      } catch (err) {
        // 409 = a turn is already running for this project. Retrying is the
        // wrong move: each POST runs the planner again and stacks another
        // plan card that can never auto-accept, so the user ends up with the
        // same request posted twice and one card stranded on "Submit".
        if (err.status === 409) {
          process.stderr.write('  ⏳ a refinement turn is already running for this project — not re-sending.\n');
          process.stderr.write('     Wait for it to finish, then send the next message.\n');
          throw fail('refinement already in progress — do not retry; wait for the running turn to finish', 4);
        }
        throw err;
      }

      // Replay cursor for THIS turn. Without it the server falls back to a
      // wall-clock window and can hand back the PREVIOUS turn's terminal
      // event — which is how a second `gaia chat` on the same page returned
      // the first request's summary and exited 0 before its own planner had
      // even run (trace 2026-07-22).
      const cursor = Number.isFinite(started?.cursor) ? started.cursor : null;

      const creds = credentials.requireAuth();
      const url = `${creds.apiBase.replace(/\/$/, '')}/api/builds/${encodeURIComponent(ctx.projectId)}/events`
        + (cursor !== null ? `?after=${cursor}` : '');
      let response;
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'text/event-stream' },
        });
      } catch (err) {
        throw fail(`could not open event stream: ${err.message}`, 1);
      }
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw fail(`event stream rejected: HTTP ${response.status}${errBody ? ' — ' + errBody.slice(0, 200) : ''}`,
          response.status === 401 || response.status >= 400 ? 3 : 1);
      }
      process.stderr.write('← streaming events (Ctrl+C exits — server continues)\n');

      // Terminal handling sets `exitCode` and breaks instead of calling
      // process.exit() inline — see the note in parseSse's finally.
      let exitCode = null;
      for await (const { payload } of parseSse(response)) {
        process.stdout.write(JSON.stringify(payload) + '\n');
        const evt = payload.event;
        const p = payload.payload || {};
        if (evt === 'planner_analyzing') {
          process.stderr.write(`  · ${p.message || 'analyzing…'}\n`);
        } else if (evt === 'planner_clarification') {
          process.stderr.write(`  ? clarification: ${p.question}\n`);
          process.stderr.write('    options: ' + (p.options || []).map((o) => o.label).join(' | ') + '\n');
          process.stderr.write('  → run `gaia chat "<your answer>"` to continue\n');
          exitCode = 2;
          break;
        } else if (evt === 'planner_plan_ready') {
          process.stderr.write(`  ▶ plan: ${p.plan?.title || '(building…)'}\n`);
        } else if (evt === 'workflow_plan_ready') {
          // Multi-stage refine: the server decomposed the request into ordered
          // build stages and auto-accepts them (no manual "Build All" needed
          // in the headless flow). Report the plan so the run isn't opaque.
          const titles = (p.stages || []).map((s) => s.title).filter(Boolean);
          process.stderr.write(`  ▶ workflow: ${titles.length} stage(s)${titles.length ? ' — ' + titles.join(' → ') : ''}\n`);
        } else if (evt === 'workflow_stage_started') {
          const n = typeof p.stageIndex === 'number' ? p.stageIndex + 1 : p.stageIndex;
          process.stderr.write(`  ▶ stage ${n}/${p.totalStages || '?'}: ${p.title || p.type || 'building'}\n`);
        } else if (evt === 'workflow_stage_complete') {
          const n = typeof p.stageIndex === 'number' ? p.stageIndex + 1 : p.stageIndex;
          process.stderr.write(`  ✓ stage ${n} complete\n`);
        } else if (evt === 'agent_started') {
          process.stderr.write(`  ▶ ${p.title || p.agent || 'building'}\n`);
        } else if (evt === 'agent_error') {
          process.stderr.write(`  ✗ ${p.error || 'agent error'}\n`);
          exitCode = 3;
          break;
        } else if (evt === 'workflow_stage_failed') {
          process.stderr.write(`  ✗ stage failed: ${p.error || 'workflow stage error'}\n`);
          exitCode = 3;
          break;
        } else if (evt === 'workflow_abandoned') {
          process.stderr.write('  ✗ workflow abandoned (build stage lost its client)\n');
          exitCode = 3;
          break;
        } else if (evt === 'workflow_complete') {
          process.stderr.write(`  ✓ done (${p.totalStages || '?'} stage(s))\n`);
          exitCode = 0;
          break;
        } else if (evt === 'completion_ready') {
          process.stderr.write('  ✓ done\n');
          exitCode = 0;
          break;
        }
      }
      if (exitCode === null) throw fail('event stream ended without a terminal event', 1);
      process.exit(exitCode);
    });
};
