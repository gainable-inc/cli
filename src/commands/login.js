const readline = require('readline');
const credentials = require('../credentials');

function readKey() {
  if (process.stdin.isTTY) {
    return new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.question('Paste your API key (visible): ', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').trim()));
  });
}

module.exports = (program) => {
  program
    .command('login')
    .description('Store an API key for subsequent commands')
    .option('--key <key>', 'API key (skip prompt)')
    .option('--api-base <url>', `API base (default ${credentials.DEFAULT_API_BASE})`)
    .action(async (opts) => {
      let key = opts.key;
      if (!key) key = await readKey();
      if (!key) {
        const err = new Error('no key provided');
        err.exitCode = 3;
        throw err;
      }
      const apiBase = opts.apiBase || process.env.GAINABLE_API_BASE || credentials.DEFAULT_API_BASE;

      // Validate by hitting /api/projects. 200 ⇒ auth works.
      const url = apiBase.replace(/\/$/, '') + '/api/projects';
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
      } catch (err) {
        const wrapped = new Error(`could not reach ${apiBase}: ${err.message}`);
        wrapped.exitCode = 1;
        throw wrapped;
      }
      if (!response.ok) {
        let body = '';
        try { body = (await response.text()).slice(0, 200); } catch { /* ignore */ }
        const err = new Error(`key rejected by ${apiBase}: HTTP ${response.status}${body ? ' — ' + body : ''}`);
        err.exitCode = 3;
        throw err;
      }

      credentials.save({ apiKey: key, apiBase });
      process.stderr.write(`saved to ${credentials.CREDENTIALS_PATH}\n`);
      process.stdout.write(JSON.stringify({ ok: true, apiBase, path: credentials.CREDENTIALS_PATH }) + '\n');
    });
};
