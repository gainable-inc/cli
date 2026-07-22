const http = require('../http');
const credentials = require('../credentials');
const project = require('../project');
const { fail } = require('../util');

/**
 * gaia build — drives the entire "make a new app" journey.
 *
 *   gaia build "I want a CRM for tracking deals"       → contract turn (typed)
 *   gaia build --reply "Classic"                       → contract turn (widget answer)
 *   gaia build --reply "A" --reply "B"                 → multi-ask reply
 *   gaia build                                         → kick the deterministic pipeline (requires phaseLock='autonomy')
 *
 * Arg/flag presence picks the path. Server enforces phaseLock — wrong-phase
 * errors come back as a clean 4xx the CLI surfaces verbatim.
 *
 * Post-build refinement (editing views on an already-built app) is the
 * BuildAgent flow under socket.on('chat_message'). It's NOT exposed over
 * HTTP yet — `gaia chat` is the planned name once the refine route exists.
 */

const LAST_ASKS_FILE = 'last-asks.json';
const LAST_TURN_FILE = 'last-turn.json';

function buildWidgetMessage(picks) {
  return picks.map(({ ask, labels }) => `${ask.question}\n${labels.join(', ')}`).join('\n\n');
}

function resolveReplies(replies, askIndex, savedAsks) {
  if (!Array.isArray(savedAsks) || savedAsks.length === 0) {
    throw fail('no pending asks from the prior turn (send a message first)');
  }
  if (replies.length === 1 && askIndex != null) {
    const idx = Number(askIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= savedAsks.length) {
      throw fail(`--ask out of range (have ${savedAsks.length} pending asks, got ${askIndex})`);
    }
    return [{ ask: savedAsks[idx], labels: replies[0].split(',').map((s) => s.trim()).filter(Boolean) }];
  }
  if (replies.length > savedAsks.length) {
    throw fail(`got ${replies.length} --reply flags but only ${savedAsks.length} pending asks`);
  }
  return replies.map((labelText, i) => ({
    ask: savedAsks[i],
    labels: labelText.split(',').map((s) => s.trim()).filter(Boolean)
  }));
}

async function runContractTurn(ctx, { message, replies, askIndex, silent, opts }) {
  let body;
  if (replies) {
    const savedAsks = project.loadState(ctx.gaiaDir, LAST_ASKS_FILE);
    const picks = resolveReplies(replies, askIndex, savedAsks?.asks);
    body = {
      projectId: ctx.projectId,
      message: buildWidgetMessage(picks),
      kind: 'widget_answer'
    };
  } else {
    body = { projectId: ctx.projectId, message, kind: 'typed' };
    if (silent) body.silent = true;
  }

  process.stderr.write(`→ contract turn (${body.kind}, projectId=${ctx.projectId})\n`);
  const response = await http.post('/api/data-analyzer/contract-turn', body);

  // Auto-pivot: typed message against an already-built project means
  // the user wants a NEW app (refinements go through `gaia chat`, not
  // `gaia build`). Server returns terminal:true so we know the project
  // is in the built terminal state — auto-init a fresh project,
  // overwrite local .gaia/project.json, and re-run the contract turn
  // against the new project. Without this pivot the response is empty
  // (no asks, no prose worth surfacing), and skills/Claude Code have
  // been observed inventing a "task already complete" conclusion
  // instead of starting the new build the user actually requested.
  // Skip for --reply (widget answers should never trigger a pivot —
  // a reply against a built project is a logic bug the user can see).
  if (response?.terminal && response?.phaseLock === 'built' && !replies && message) {
    process.stderr.write(`← existing project is in 'built' state — starting a NEW project for this build request\n`);
    process.stderr.write(`  ${response.prose}\n`);
    const newCtx = await autoInitProject(message, opts || {});
    return runContractTurn(newCtx, { message, replies: undefined, askIndex, silent, opts });
  }

  const asks = Array.isArray(response?.interactiveOptions) ? response.interactiveOptions : [];
  const textAsks = Array.isArray(response?.interactiveTextInput) ? response.interactiveTextInput : [];
  project.saveState(ctx.gaiaDir, LAST_ASKS_FILE, { asks, textAsks, savedAt: new Date().toISOString() });
  project.saveState(ctx.gaiaDir, LAST_TURN_FILE, { response, savedAt: new Date().toISOString() });

  if (asks.length > 0) {
    process.stderr.write(`← ${asks.length} ask(s) pending — reply with: gaia build --reply "<label>"\n`);
  } else if (response?.phase === 'autonomy') {
    process.stderr.write(`← contract ready — run \`gaia build\` (no args) to kick the pipeline\n`);
  }
  process.stdout.write(JSON.stringify(response, null, 2) + '\n');
  // Exit 0 even when asks are pending. Earlier behavior was exit 2
  // (documented as "pending input"), but Claude Code surfaces any
  // non-zero exit as "command FAILED" — the call returns successfully
  // server-side, asks are in the JSON, and Claude needs to forward
  // them via AskUserQuestion. Trace 2026-05-31: Claude Code reported
  // "Reply with Classic sidebar layout selection failed with exit
  // code 2" and lost the conversation thread, leaving the user
  // stranded. Pending-asks signal now lives ONLY in the JSON
  // (response.interactiveOptions / interactiveTextInput). The stderr
  // line already states "← N ask(s) pending" for human readers.
}

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
    // Exiting with a read still pending on the fetch body tears the loop
    // down mid-close and trips a libuv assertion on Windows
    // (`!(handle->flags & UV_HANDLE_CLOSING)`, src\win\async.c:76) — the
    // CLI prints its success line and THEN crashes. Breaking out of the
    // `for await` runs this finally first, releasing the socket.
    try { await reader.cancel(); } catch { /* stream already torn down */ }
  }
}

// Orange-tinted spinner on stderr for the deterministic-pipeline phase.
// Cycles "/", "-", "\", "|" every 120ms over the current stage title.
// Skips the carriage-return overwrite on non-TTY (CI logs, file redirect)
// so captured output stays grep-friendly: each stage prints clean
// "▶ name" / "✓ name (Ns)" lines instead of mangled \r animation frames.
//
// Claude Code's Bash tool runs commands with stderr attached as a TTY,
// so the spinner renders inline there. When piped or wrapped, the
// fallback path keeps the output readable.
const ANSI = {
  orange: '\x1b[38;5;208m',
  dim:    '\x1b[2m',
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  clear:  '\r\x1b[K',
};
const FRAMES = ['/', '-', '\\', '|'];

function makeSpinner() {
  const isTTY = !!process.stderr.isTTY;
  let timer = null;
  let frameIdx = 0;
  let label = '';
  let startedAt = 0;

  const render = () => {
    if (!isTTY) return;
    const ch = FRAMES[frameIdx % FRAMES.length];
    process.stderr.write(`${ANSI.clear}${ANSI.orange}${ch}${ANSI.reset} ${label}`);
    frameIdx++;
  };

  let lastNoteAt = 0;
  let lastNoteText = '';

  return {
    start(text) {
      label = text;
      startedAt = Date.now();
      if (!isTTY) {
        process.stderr.write(`  ▶ ${text}\n`);
        return;
      }
      render();
      timer = setInterval(render, 120);
    },
    // Heartbeat between stage boundaries for non-TTY consumers (agents,
    // redirected logs): stages can run 30-60s+ with no ▶/✓ line, which
    // reads as a stall once stdout JSON is redirected away. Prints a
    // throttled sub-line per progress step; TTY users have the spinner.
    note(text) {
      if (isTTY || !text) return;
      const now = Date.now();
      if (text === lastNoteText || now - lastNoteAt < 4000) return;
      lastNoteAt = now;
      lastNoteText = text;
      process.stderr.write(`    · ${String(text).replace(/_/g, ' ')}\n`);
    },
    succeed(text, suffix) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (timer) { clearInterval(timer); timer = null; }
      const tail = suffix ? ` ${ANSI.dim}${suffix}${ANSI.reset}` : '';
      if (isTTY) {
        process.stderr.write(`${ANSI.clear}${ANSI.green}✓${ANSI.reset} ${text} ${ANSI.dim}(${elapsed}s)${ANSI.reset}${tail}\n`);
      } else {
        process.stderr.write(`  ✓ ${text} (${elapsed}s)${suffix ? ` ${suffix}` : ''}\n`);
      }
    },
    fail(text, errMsg) {
      if (timer) { clearInterval(timer); timer = null; }
      if (isTTY) {
        process.stderr.write(`${ANSI.clear}${ANSI.red}✗${ANSI.reset} ${text}${errMsg ? `: ${errMsg}` : ''}\n`);
      } else {
        process.stderr.write(`  ✗ ${text}${errMsg ? `: ${errMsg}` : ''}\n`);
      }
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      if (isTTY) process.stderr.write(ANSI.clear);
    },
  };
}

async function kickPipeline(ctx) {
  process.stderr.write(`→ build start: ${ctx.projectId}\n`);
  const started = await http.post(`/api/projects/${encodeURIComponent(ctx.projectId)}/build`);

  // Replay cursor for THIS build. Without it the server replays a
  // wall-clock window, which can include a previous turn's terminal event
  // and close the stream before this build has emitted anything.
  const cursor = Number.isFinite(started?.cursor) ? started.cursor : null;

  const creds = credentials.requireAuth();
  const url = `${creds.apiBase.replace(/\/$/, '')}/api/builds/${encodeURIComponent(ctx.projectId)}/events`
    + (cursor !== null ? `?after=${cursor}` : '');
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.apiKey}`, Accept: 'text/event-stream' }
    });
  } catch (err) {
    throw fail(`could not open event stream: ${err.message}`, 1);
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw fail(`event stream rejected: HTTP ${response.status}${body ? ' — ' + body.slice(0, 200) : ''}`,
      response.status === 401 || response.status >= 400 ? 3 : 1);
  }
  process.stderr.write(`← streaming events ${ANSI.dim}(Ctrl+C exits — build continues server-side)${ANSI.reset}\n`);

  const spinner = makeSpinner();
  let currentLabel = '';
  let builtAppName = null;
  let buildResult = null; // { success, error? } — populated by build_complete
  process.on('SIGINT', () => { spinner.stop(); process.exit(130); });

  const apiBase = creds.apiBase.replace(/\/$/, '');

  // Helper: finalize the build outcome. Called when we've seen both
  // build_complete and (ideally) app_ready, OR when the SSE stream
  // ends — whichever happens first after build_complete lands. The
  // launcher URL points at the MAIN APP (`<apiBase>/apps/<appName>`),
  // not the public Traefik `<app>.localhost` URL. The public URL
  // exists but the iframe-launcher protocol injects an auth key that
  // a raw click can't supply, so it 401s / renders empty. The main-app
  // /apps/:appName route serves an authenticated launcher that wraps
  // the app in the right iframe.
  //
  // Returns the exit code once the outcome is known, or null if we're still
  // waiting on build_complete. The caller breaks out of the stream on a
  // non-null result rather than exiting inline — see parseSse's finally.
  const finalize = () => {
    if (!buildResult) return null; // no build_complete yet
    spinner.stop();
    if (buildResult.success) {
      const launcherUrl = builtAppName
        ? `${apiBase}/apps/${encodeURIComponent(builtAppName)}`
        : null;
      if (launcherUrl) {
        process.stderr.write(`${ANSI.green}✓ build succeeded${ANSI.reset} — open: ${launcherUrl}\n`);
        // Tagged stdout line so the skill can grep for the canonical
        // URL without re-parsing the JSON stream. Emitted as a synthetic
        // SSE-shaped JSON line for symmetry with the other events.
        process.stdout.write(JSON.stringify({
          event: 'app_launcher',
          payload: { url: launcherUrl, appName: builtAppName },
        }) + '\n');
      } else {
        process.stderr.write(`${ANSI.green}✓ build succeeded${ANSI.reset}\n`);
      }
      return 0;
    }
    process.stderr.write(`${ANSI.red}✗ build failed: ${buildResult.error || 'unknown'}${ANSI.reset}\n`);
    return 3;
  };

  let exitCode = null;
  for await (const { payload } of parseSse(response)) {
    process.stdout.write(JSON.stringify(payload) + '\n');
    const evt = payload.event;
    const p = payload.payload || {};
    if (evt === 'workflow_stage_started') {
      currentLabel = p.title || p.type || String(p.stageIndex);
      spinner.start(currentLabel);
    } else if (evt === 'workflow_stage_complete') {
      const suffix = p.filesCreated != null ? `${p.filesCreated} file(s)` : '';
      spinner.succeed(currentLabel || `stage ${p.stageIndex}`, suffix);
    } else if (evt === 'workflow_stage_failed') {
      spinner.fail(currentLabel || `stage ${p.stageIndex}`, p.error);
    } else if (evt === 'progress') {
      spinner.note(p.step);
    } else if (evt === 'app_ready') {
      // Pipeline emits app_ready AFTER build_complete with appName.
      // If build_complete already landed (success path), this is the
      // last piece we need — finalize. Failures don't reach this event.
      if (p.appName) builtAppName = p.appName;
      exitCode = finalize();
      if (exitCode !== null) break;
    } else if (evt === 'build_complete') {
      // Capture outcome but defer the exit — on success, we wait for
      // app_ready so we can include the launcher URL. On failure, no
      // app_ready will arrive (failure short-circuits earlier), so
      // finalize immediately.
      buildResult = { success: !!p.success, error: p.error };
      if (!buildResult.success) {
        exitCode = finalize();
        if (exitCode !== null) break;
      }
    } else if (evt === 'workflow_complete') {
      // Belt-and-suspenders: if app_ready was dropped or never reached
      // us, the terminal workflow_complete still finalizes the build.
      exitCode = finalize();
      if (exitCode !== null) break;
    }
  }
  // Stream ended naturally. If we have a buildResult but never saw
  // app_ready / workflow_complete, finalize with no launcher URL.
  if (exitCode === null) exitCode = finalize();
  if (exitCode === null) throw fail('event stream ended before build_complete', 1);
  process.exit(exitCode);
}

// Auto-init: when the user runs `gaia build "<idea>"` in an empty
// directory with no .gaia/project.json, create a fresh project
// server-side and write the local .gaia/project.json. Makes the
// from-scratch flow one command. The default name is the first ~50
// chars of the message trimmed at a word boundary; --name overrides.
async function autoInitProject(message, opts) {
  let projectName = opts.name && opts.name.trim();
  if (!projectName) {
    const trimmed = (message || '').replace(/\s+/g, ' ').trim();
    if (trimmed.length <= 50) {
      projectName = trimmed;
    } else {
      const cut = trimmed.slice(0, 50);
      const lastSpace = cut.lastIndexOf(' ');
      projectName = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
    }
    if (!projectName) projectName = 'Untitled Project';
  }
  process.stderr.write(`→ no .gaia/ here — creating "${projectName}"…\n`);
  const created = await http.post('/api/projects', { projectName });
  if (!created || !created.projectId) {
    throw fail('project create failed — no projectId in response', 1);
  }
  const apiBase = credentials.load().apiBase;
  const ctx = project.writeProjectFiles({
    projectId: created.projectId,
    projectName: created.projectName,
    apiBase,
  });
  process.stderr.write(`  + .gaia/project.json (id=${created.projectId})\n`);
  return ctx;
}

module.exports = (program) => {
  program
    .command('build')
    .description('Drive the new-app build journey (contract turns + deterministic pipeline). In an empty dir with a message, auto-creates the project.')
    .argument('[message]', 'message for the contract agent — omit to kick the pipeline')
    .option('--project <id>', 'override project context (skips .gaia/ discovery)')
    .option('--name <projectName>', 'name to give a newly-created project when auto-init triggers (defaults to first words of the message)')
    .option('--reply <labels>', 'reply to a pending ask (comma-separated for multi-select); repeatable for multi-ask turns', (v, prev) => prev ? [...prev, v] : [v])
    .option('--ask <index>', 'pair the single --reply with this 0-indexed ask')
    .option('--silent', 'send the message as a silent system turn (no chat bubble)')
    .action(async (message, opts) => {
      let ctx;
      try {
        ctx = project.resolveProject({ projectIdOverride: opts.project });
      } catch (err) {
        // No .gaia/project.json AND no --project flag. If we have a
        // message, this is the "start a new app from scratch" path —
        // create the project server-side and proceed. Otherwise the
        // user is trying to kick the pipeline without context; fail
        // with the helpful error.
        if (message) {
          ctx = await autoInitProject(message, opts);
        } else {
          throw err;
        }
      }
      const hasConversationInput = !!(message || opts.reply);
      if (hasConversationInput) {
        return runContractTurn(ctx, {
          message,
          replies: opts.reply,
          askIndex: opts.ask,
          silent: opts.silent,
          opts,
        });
      }
      return kickPipeline(ctx);
    });
};

// Exposed for tests (heartbeat throttling); not part of the CLI surface.
module.exports.makeSpinner = makeSpinner;
