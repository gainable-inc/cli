const http = require('../http');
const project = require('../project');
const { fail } = require('../util');

/**
 * gaia publish — deploys the current built app to its
 * <slug>.gainable.app URL by calling the same publish flow the main
 * UI's "Publish" button uses (POST /api/apps/:appName/publish).
 *
 *   gaia publish              → publish (or republish) and surface the URL
 *   gaia publish --status     → peek at current publish state, no upload
 *
 * The publish endpoint is appName-keyed; the CLI stores only projectId
 * locally in .gaia/project.json, so we do one preflight GET to resolve
 * the appName before posting to publish. Both endpoints are
 * sessionOrApiKey-protected, so Bearer auth works (same as gaia
 * build / chat).
 *
 * Response shape on success (POST /api/apps/:appName/publish):
 *   { success: true, url: "slug.gainable.app", message: "..." }
 * The `url` value has no scheme — we prepend https:// before
 * surfacing.
 */

async function resolveAppName(projectId) {
  const data = await http.get(`/api/projects/${encodeURIComponent(projectId)}`);
  const appName = data?.project?.appName;
  if (!appName) {
    throw fail(
      `project "${projectId}" has no appName — has the build pipeline finished? (run \`gaia build\` first)`,
      3
    );
  }
  return appName;
}

module.exports = (program) => {
  program
    .command('publish')
    .description('Publish the current built app to its <slug>.gainable.app URL. Mirrors the Publish button in the main UI.')
    .option('--project <id>', 'override project context (skips .gaia/ discovery)')
    .option('--status', 'show current publish state without publishing')
    .action(async (opts) => {
      const ctx = project.resolveProject({ projectIdOverride: opts.project });
      const appName = await resolveAppName(ctx.projectId);

      if (opts.status) {
        const status = await http.get(`/api/apps/${encodeURIComponent(appName)}/publish-status`);
        // Publish-status returns the URL without scheme — normalize so the
        // skill (and humans) get a clickable string.
        const url = status?.url ? `https://${status.url}` : null;
        process.stdout.write(JSON.stringify(status, null, 2) + '\n');
        if (status?.published && url) {
          process.stderr.write(`← published at ${url}${status.running ? ' (live)' : ' (offline)'}\n`);
        } else {
          process.stderr.write(`← not yet published — run \`gaia publish\` to deploy\n`);
        }
        return;
      }

      process.stderr.write(`→ publish start: ${appName}\n`);
      const result = await http.post(`/api/apps/${encodeURIComponent(appName)}/publish`);
      if (!result?.success) {
        throw fail(`publish failed: ${result?.error || 'unknown'}`, 3);
      }
      const url = result.url ? `https://${result.url}` : null;
      if (url) {
        process.stderr.write(`✓ published — open: ${url}\n`);
        // Tagged stdout event so the skill can read the canonical URL
        // without re-parsing the success payload. Symmetric with the
        // `app_launcher` event the build command emits.
        process.stdout.write(JSON.stringify({
          event: 'app_published',
          payload: { url, appName },
        }) + '\n');
      } else {
        process.stderr.write(`✓ published\n`);
      }
    });
};
