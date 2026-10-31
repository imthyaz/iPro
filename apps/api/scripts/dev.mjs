// Dev loop without extra dependencies: tsc rebuilds on change, node restarts on rebuilt output.
import { spawn, spawnSync } from 'node:child_process';

const tsc = ['exec', 'tsc', '-p', 'tsconfig.build.json'];
const first = spawnSync('pnpm', tsc, { stdio: 'inherit', shell: true });
if (first.status !== 0) process.exit(first.status ?? 1);

const children = [
  spawn('pnpm', [...tsc, '--watch', '--preserveWatchOutput'], { stdio: 'inherit', shell: true }),
  spawn('node', ['--env-file-if-exists=../../.env', '--watch', 'dist/main.js'], {
    stdio: 'inherit',
    shell: true,
  }),
];

const stop = () => children.forEach((child) => child.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
