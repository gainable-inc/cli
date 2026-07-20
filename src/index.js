const { Command } = require('commander');
const pkg = require('../package.json');

const program = new Command();
program
  .name('gaia')
  .description(pkg.description)
  .version(pkg.version);

require('./commands/login')(program);
require('./commands/logout')(program);
require('./commands/init')(program);
require('./commands/apps')(program);
require('./commands/build')(program);
require('./commands/chat')(program);
require('./commands/code')(program);
require('./commands/import')(program);
require('./commands/dataset')(program);
require('./commands/publish')(program);

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`error: ${err.message}\n`);
  process.exit(typeof err.exitCode === 'number' ? err.exitCode : 1);
});
