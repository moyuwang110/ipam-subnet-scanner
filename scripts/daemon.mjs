// IPAM 后台运行管理脚本：start / stop / restart / status
// 用法：node scripts/daemon.mjs <command>（或通过 npm run bg:* 调用）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const pidFile = path.join(dataDir, 'ipam.pid');
const logFile = path.join(dataDir, 'ipam.log');

function readPid() {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function start() {
  const existing = readPid();
  if (isRunning(existing)) {
    console.log(`IPAM 已在后台运行（PID ${existing}），无需重复启动。`);
    return;
  }
  // 清理残留的过期 pid 文件
  if (existing) fs.rmSync(pidFile, { force: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/server/index.ts'], {
    cwd: root,
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(pidFile, String(child.pid));
  // 给进程一点时间验证端口绑定是否成功
  await sleep(800);
  if (isRunning(child.pid)) {
    console.log(`IPAM 已后台启动（PID ${child.pid}）。`);
    console.log(`日志：${logFile}`);
    console.log('停止命令：npm run bg:stop');
  } else {
    fs.rmSync(pidFile, { force: true });
    console.error('IPAM 启动失败，请查看日志：');
    console.error(fs.readFileSync(logFile, 'utf8').split('\n').slice(-10).join('\n'));
    process.exitCode = 1;
  }
}

async function stop() {
  const pid = readPid();
  if (!isRunning(pid)) {
    fs.rmSync(pidFile, { force: true });
    console.log('IPAM 未在后台运行。');
    return;
  }
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (isRunning(pid) && Date.now() < deadline) {
    await sleep(100);
  }
  if (isRunning(pid)) {
    process.kill(pid, 'SIGKILL');
    await sleep(200);
  }
  fs.rmSync(pidFile, { force: true });
  console.log(`IPAM 已停止（PID ${pid}）。`);
}

function status() {
  const pid = readPid();
  if (isRunning(pid)) {
    console.log(`IPAM 正在后台运行（PID ${pid}）。`);
  } else {
    console.log('IPAM 未在后台运行。');
    process.exitCode = 1;
  }
}

const cmd = process.argv[2] ?? 'start';
if (cmd === 'start') await start();
else if (cmd === 'stop') await stop();
else if (cmd === 'restart') {
  await stop();
  await start();
} else if (cmd === 'status') status();
else {
  console.error(`未知命令：${cmd}。可用命令：start | stop | restart | status`);
  process.exitCode = 1;
}
