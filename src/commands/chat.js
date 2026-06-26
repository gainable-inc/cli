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
 *   0 — completion_ready (success)
 *   1 — transport error
 *   2 — planner_clarification (user owes a reply; just run `gaia chat`
 *       again with their answer — the server detects the pending
 *       clarification and merges the answer in)
 *   3 — agent_error / validation / auth
 */

async function* parseSse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
      await http.post(`/api/projects/${encodeURIComponent(ctx.projectId)}/refine`, body);

      const creds = credentials.requireAuth();
      const url = `${creds.apiBase.replace(/\/$/, '')}/api/builds/${encodeURIComponent(ctx.projectId)}/events`;
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
          process.exit(2);
        } else if (evt === 'planner_plan_ready') {
          process.stderr.write(`  ▶ plan: ${p.plan?.title || '(building…)'}\n`);
        } else if (evt === 'agent_started') {
          process.stderr.write(`  ▶ ${p.title || p.agent || 'building'}\n`);
        } else if (evt === 'agent_error') {
          process.stderr.write(`  ✗ ${p.error || 'agent error'}\n`);
          process.exit(3);
        } else if (evt === 'completion_ready') {
          process.stderr.write('  ✓ done\n');
          process.exit(0);
        }
      }
      throw fail('event stream ended without a terminal event', 1);
    });
};
