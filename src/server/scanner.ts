import net from 'node:net';
import dns from 'node:dns/promises';
import os from 'node:os';
import fs from 'node:fs';
import type { Subnet, AddressRecord } from '../shared/cidr.js';
import { generateAddresses } from '../shared/cidr.js';
import { mergeProbesToAddresses, type RawProbe } from '../shared/status.js';
import { withWrite, read, newId } from './store.js';

export interface ScanOptions {
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  ports?: number[];
  signal?: AbortSignal;
  /** test hook: custom probe function. defaults to TCP probe. */
  probe?: (ip: string, opts: { timeoutMs: number; ports: number[]; retries: number }) => Promise<RawProbe>;
  /** test hook: custom MAC resolver */
  resolveMac?: (ip: string) => string | undefined;
  /** test hook: custom reverse DNS */
  reverseLookup?: (ip: string) => Promise<string | undefined>;
}

export interface ScanProgress {
  done: number;
  total: number;
  current?: string;
}

export type ProgressCallback = (p: ScanProgress) => void;

const DEFAULT_PORTS = [80, 443, 22, 3389, 445, 8080];

async function reverseLookup(ip: string): Promise<string | undefined> {
  try {
    const hostnames = await dns.reverse(ip);
    return hostnames[0];
  } catch {
    return undefined;
  }
}

function tryArpForIp(ip: string): string | undefined {
  try {
    const file = '/proc/net/arp';
    const data = fs.readFileSync(file, 'utf-8') as string;
    const lines = data.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === ip) {
        const mac = parts[3];
        if (mac && mac !== '00:00:00:00:00:00' && mac !== '<incomplete>') return mac;
      }
    }
  } catch {
    // not linux/permissions etc
  }
  return undefined;
}

function localMacForIp(ip: string): string | undefined {
  // best-effort: if ip is one of our local interfaces, use its MAC
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] ?? []) {
        if (info.address === ip) return info.mac;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

async function probeTcp(ip: string, port: number, timeoutMs: number): Promise<{ alive: boolean; responseMs?: number }> {
  const start = Date.now();
  return await new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const onDone = (alive: boolean, err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (alive) resolve({ alive: true, responseMs: Date.now() - start });
      else resolve({ alive: false });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => onDone(true));
    socket.once('timeout', () => onDone(false));
    socket.once('error', () => onDone(false));
    socket.connect(port, ip);
  });
}

async function probeOne(
  ip: string,
  opts: { timeoutMs: number; retries: number; ports: number[]; probe?: ScanOptions['probe']; resolveMac?: ScanOptions['resolveMac']; reverseLookup?: ScanOptions['reverseLookup'] },
): Promise<RawProbe> {
  const scannedAt = new Date().toISOString();
  const { timeoutMs, retries, ports, probe, resolveMac, reverseLookup } = opts;
  let alive = false;
  let responseMs: number | undefined;
  let source: string | undefined;
  let openPorts: number[] | undefined;
  let lastError: string | undefined;
  let macFromProbe: string | undefined;
  let hostnameFromProbe: string | undefined;
  if (probe) {
    let r!: RawProbe;
    for (let attempt = 0; attempt <= retries; attempt++) {
      r = await probe(ip, { timeoutMs, ports, retries: retries - attempt });
      if (r.alive) break;
    }
    alive = r.alive;
    responseMs = r.responseMs;
    source = r.source;
    lastError = r.error;
    macFromProbe = r.mac;
    hostnameFromProbe = r.hostname;
    openPorts = r.ports;
  } else {
    // 对每个端口都尝试连接，收集全部开放端口（而非发现第一个就停止），
    // 供前端悬停展示端口开放情况。未开放端口在内网中会被立即拒绝，开销很小。
    for (let attempt = 0; attempt <= retries && !alive; attempt++) {
      const open: number[] = [];
      let firstMs: number | undefined;
      for (const port of ports) {
        const r = await probeTcp(ip, port, timeoutMs);
        if (r.alive) {
          open.push(port);
          if (firstMs === undefined) firstMs = r.responseMs;
        }
      }
      if (open.length > 0) {
        alive = true;
        responseMs = firstMs;
        source = `tcp/${open[0]}`;
        openPorts = open;
      }
    }
  }
  let mac: string | undefined = macFromProbe ?? (resolveMac ? resolveMac(ip) : tryArpForIp(ip) ?? localMacForIp(ip));
  let hostname: string | undefined = hostnameFromProbe;
  if (alive && hostname === undefined) {
    hostname = reverseLookup ? await reverseLookup(ip) : await realReverseLookup(ip);
  }
  return {
    ip,
    alive,
    mac,
    hostname,
    responseMs,
    source,
    ports: alive ? openPorts : undefined,
    scannedAt,
    error: alive ? undefined : (lastError ?? 'no-response'),
  };
}

async function realReverseLookup(ip: string): Promise<string | undefined> {
  return reverseLookup(ip);
}

const scanLocks = new Map<string, Promise<unknown>>();
const activeJobs = new Map<string, string>(); // subnetId -> jobId

export interface ScanResult {
  jobId: string;
  subnetId: string;
  total: number;
  used: number;
  free: number;
  unknown: number;
  conflict: number;
  records: AddressRecord[];
}

export async function scanSubnet(
  subnet: Subnet,
  opts: ScanOptions = {},
  onProgress?: ProgressCallback,
): Promise<ScanResult> {
  const existing = scanLocks.get(subnet.id);
  if (existing) {
    throw new Error('SCAN_IN_PROGRESS');
  }

  const jobId = newId('job-');
  const addresses = generateAddresses(subnet.cidr);
  const total = addresses.length;
  const concurrency = Math.max(1, opts.concurrency ?? 64);
  const timeoutMs = opts.timeoutMs ?? 800;
  const retries = opts.retries ?? 0;
  const ports = opts.ports && opts.ports.length > 0 ? opts.ports : DEFAULT_PORTS;

  // Reserve the lock and jobId synchronously so the caller can read them before the
  // first withWrite round-trip completes. The run() promise below still owns the
  // lifecycle and clears the lock in .finally().
  activeJobs.set(subnet.id, jobId);
  const run = async (): Promise<ScanResult> => {
    await withWrite((data) => {
      data.jobs.push({
        id: jobId,
        subnetId: subnet.id,
        status: 'running',
        startedAt: new Date().toISOString(),
        progress: { done: 0, total },
      });
      data.subnets = data.subnets.map((s) => s.id === subnet.id ? { ...s, lastScanStatus: 'running', lastScanError: undefined } : s);
    });

    onProgress?.({ done: 0, total });

    const probes: RawProbe[] = new Array(total);
    let cursor = 0;
    let done = 0;
    const workers: Array<Promise<void>> = [];

    const report = () => {
      onProgress?.({ done, total });
      void read((data) => {
        const job = data.jobs.find((j) => j.id === jobId);
        if (job) job.progress = { done, total };
      }).then(() => undefined);
    };

    const tick = setInterval(report, 250);
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        // workers finish naturally but new tasks not started
      });
    }

    const work = async () => {
      while (true) {
        if (opts.signal?.aborted) break;
        const idx = cursor++;
        if (idx >= total) break;
        const ip = addresses[idx];
        onProgress?.({ done, total, current: ip });
        try {
          probes[idx] = await probeOne(ip, {
            timeoutMs,
            retries,
            ports,
            probe: opts.probe,
            resolveMac: opts.resolveMac,
            reverseLookup: opts.reverseLookup,
          });
        } catch (err: any) {
          probes[idx] = {
            ip,
            alive: false,
            scannedAt: new Date().toISOString(),
            error: err?.message ?? 'probe error',
          };
        }
        done++;
      }
    };

    for (let i = 0; i < concurrency; i++) workers.push(work());
    await Promise.all(workers);
    clearInterval(tick);
    onProgress?.({ done, total });

    const previous = await read((data) => data.addresses[subnet.id] ?? {});
    const records = mergeProbesToAddresses(probes, previous);
    let used = 0, free = 0, unknown = 0, conflict = 0;
    for (const r of records) {
      if (r.status === 'used') used++;
      else if (r.status === 'free') free++;
      else if (r.status === 'unknown') unknown++;
      else if (r.status === 'conflict') conflict++;
    }

    await withWrite((data) => {
      data.addresses[subnet.id] = Object.fromEntries(records.map((r) => [r.ip, r]));
      const job = data.jobs.find((j) => j.id === jobId);
      if (job) {
        job.status = 'completed';
        job.finishedAt = new Date().toISOString();
        job.progress = { done: total, total };
      }
      data.subnets = data.subnets.map((s) => s.id === subnet.id ? {
        ...s,
        lastScanAt: new Date().toISOString(),
        lastScanStatus: 'completed',
        lastScanError: undefined,
      } : s);
    });

    return {
      jobId,
      subnetId: subnet.id,
      total,
      used,
      free,
      unknown,
      conflict,
      records,
    };
  };

  const promise = run()
    .catch(async (err) => {
      await failJob(subnet.id, jobId, err?.message ?? 'scan failed');
      throw err;
    })
    .finally(() => {
      scanLocks.delete(subnet.id);
      // Only clear the activeJobs entry if it still references this jobId.
      // A new scan started by another caller will have already replaced it.
      if (activeJobs.get(subnet.id) === jobId) activeJobs.delete(subnet.id);
    });
  scanLocks.set(subnet.id, promise);
  return promise;
}

export function currentJobId(subnetId: string): string | undefined {
  return activeJobs.get(subnetId);
}

export async function failJob(subnetId: string, jobId: string, error: string): Promise<void> {
  await withWrite((data) => {
    const job = data.jobs.find((j) => j.id === jobId);
    if (job) {
      job.status = 'failed';
      job.error = error;
      job.finishedAt = new Date().toISOString();
    }
    data.subnets = data.subnets.map((s) => s.id === subnetId ? {
      ...s,
      lastScanStatus: 'failed',
      lastScanError: error,
      lastScanAt: new Date().toISOString(),
    } : s);
  });
}

export function isScanning(subnetId: string): boolean {
  return scanLocks.has(subnetId);
}
