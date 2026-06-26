const credentials = require('../credentials');

module.exports = (program) => {
  program
    .command('logout')
    .description('Delete the local credentials file')
    .action(() => {
      const removed = credentials.clear();
      process.stdout.write(JSON.stringify({ ok: true, removed, path: credentials.CREDENTIALS_PATH }) + '\n');
    });
};
