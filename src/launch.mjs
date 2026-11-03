// 一键启动：服务端 + 电脑端助手。演示「电脑离线」时可单独结束助手进程。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const children = [];

function start(name, file) {
  const args = existsSync(join(ROOT, '.env')) ? ['--env-file=.env', file] : [file];
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, LONGXIA_LAUNCHED: '1' } });
  children.push(child);
  child.on('exit', code => {
    if (name === '服务端') {
      console.log(`${name}已退出（${code}）`);
      stop(code ?? 0);
    }
  });
  return child;
}

start('服务端', join(ROOT, 'src/server.mjs'));
setTimeout(() => start('电脑端助手', join(ROOT, 'src/agent/agent.mjs')), 600);

// 任何一方退出都把整组进程带走，避免残留的助手进程重复领取任务
function stop(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill('SIGTERM');
  process.exit(code);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
process.on('SIGHUP', () => stop()); // 关闭终端窗口
