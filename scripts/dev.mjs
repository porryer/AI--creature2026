// 同时启动后端与前端开发服务器，任一退出时一并结束
import { spawn } from 'node:child_process';

const procs = [
  ['server', ['run', 'dev', '-w', '@creature/server'], '\x1b[32m'],
  ['web', ['run', 'dev:api', '-w', '@creature/web'], '\x1b[36m'],
].map(([name, args, color]) => {
  const p = spawn('npm', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const tag = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => stream.on('data', (d) => out.write(String(d).replace(/^(?=.)/gm, tag)));
  pipe(p.stdout, process.stdout);
  pipe(p.stderr, process.stderr);
  return p;
});

const stop = (code = 0) => {
  procs.forEach((p) => p.exitCode === null && p.kill('SIGTERM'));
  process.exit(code);
};
procs.forEach((p) => p.on('exit', (code) => stop(code ?? 0)));
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
