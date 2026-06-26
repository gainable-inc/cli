const http = require('../http');

module.exports = (program) => {
  const apps = program
    .command('apps')
    .description('Manage Gainable apps');

  apps
    .command('list')
    .description('List apps in your account')
    .option('-q, --query <text>', 'Filter by name')
    .action(async (opts) => {
      const url = opts.query
        ? `/api/projects?q=${encodeURIComponent(opts.query)}`
        : '/api/projects';
      const data = await http.get(url);
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    });

  apps
    .command('create [name]')
    .description('Create a new empty Gainable project (server-side); use `gaia init --project <id>` afterwards to scaffold the workspace, or just run `gaia build "<idea>"` to auto-create + start the build journey in one shot.')
    .action(async (name) => {
      const projectName = (name && name.trim()) || 'Untitled Project';
      const data = await http.post('/api/projects', { projectName });
      process.stdout.write(JSON.stringify(data, null, 2) + '\n');
    });
};

