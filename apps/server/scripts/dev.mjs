// 开发模式：tsc 增量编译 + node --watch 自动重启（保留装饰器元数据，Nest 依赖注入需要）
import { spawn, spawnSync } from 'node:child_process';

const first = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
if (first.status !== 0) process.exit(first.status ?? 1);

const tsc = spawn('npx', ['tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], { stdio: 'inherit' });
const node = spawn(process.execPath, ['--watch', '--enable-source-maps', '--env-file-if-exists=.env', 'dist/main.js'], { stdio: 'inherit', env: process.env });
const stop = () => {
  tsc.kill('SIGTERM');
  node.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
node.on('exit', (code) => {
  tsc.kill('SIGTERM');
  process.exit(code ?? 0);
});
