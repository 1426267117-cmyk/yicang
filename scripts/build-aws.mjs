import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const vinextCli = fileURLToPath(new URL('../node_modules/vinext/dist/cli.js', import.meta.url));
const result = spawnSync(process.execPath, [vinextCli, 'build', ...process.argv.slice(2)], {
  env: { ...process.env, ERP_DEPLOY_TARGET: 'aws' },
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
