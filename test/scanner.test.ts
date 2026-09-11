// Set env BEFORE any module that depends on DATA_DIR is imported.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DIR = path.join(os.tmpdir(), `ipam-test-${randomUUID()}`);
process.env.IPAM_DATA_DIR = TMP_DIR;
process.env.IPAM_DISABLE_AUTOSTART = '1';
await fs.mkdir(TMP_DIR, { recursive: true });
await fs.writeFile(path.join(TMP_DIR, 'ipam.json'), JSON.stringify({ subnets: [], addresses: {}, jobs: [] }));

import assert from 'node:assert/strict';
const { describe, it, beforeEach, after } = await import('node:test');
const { scanSubnet, isScanning, failJob, currentJobId }: typeof import('../src/server/scanner.js') = await import('../src/server/scanner.js');
const { withWrite, read, DATA_FILE }: typeof import('../src/server/store.js') = await import('../src/server/store.js');
import type { Subnet } from '../src/shared/cidr.js';
import type { Server } from 'node:net';

function makeSubnet(name: string, cidr: string, id = 'sub-' + Math.random().toString(36).slice(2, 8)): Subnet {
  return {
    id,
    name,
    cidr,
    network: '0.0.0.0',
    prefix: 24,
    mask: '255.255.255.0',
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('scanner', () => {
  beforeEach(async () => {
    await withWrite((data) => {
      data.subnets = [];
      data.addresses = {};
      data.jobs = [];
    });
  });

  after(async () => {
    try { await fs.rm(path.dirname(DATA_FILE), { recursive: true, force: true }); } catch {}
  });

  it('scans a /30 and produces used/free/host records via injected probe', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '192.168.99.0/30', 'sub-test1'));
    });
    const result = await scanSubnet(
      makeSubnet('lab', '192.168.99.0/30', 'sub-test1'),
      {
        probe: async (ip) => ({
          ip,
          alive: ip === '192.168.99.1',
          mac: ip === '192.168.99.1' ? 'aa:bb:cc:00:00:01' : undefined,
          hostname: ip === '192.168.99.1' ? 'host-1' : undefined,
          responseMs: 5,
          source: 'tcp/80',
          scannedAt: new Date().toISOString(),
        }),
      },
    );
    assert.equal(result.total, 2);
    assert.equal(result.used, 1);
    assert.equal(result.free, 1);
    assert.equal(result.conflict, 0);
    const used = result.records.find((r) => r.status === 'used');
    assert.ok(used);
    assert.equal(used!.mac, 'aa:bb:cc:00:00:01');
  });

  it('default TCP probe collects all open ports for a live host', async () => {
    const net = await import('node:net');
    // 在 127.0.0.1 上监听两个测试端口（显式绑定到 127.0.0.1，确保 127.0.0.2 不可达）
    const servers = await Promise.all([18111, 18222].map((port) => new Promise<Server>((resolve) => {
      const s = net.createServer();
      s.listen(port, '127.0.0.1', () => resolve(s));
    })));
    try {
      const result = await scanSubnet(makeSubnet('ports', '127.0.0.0/30', 'sub-test-ports'), {
        ports: [18111, 18222, 18333],
        timeoutMs: 300,
        // 跳过反向解析与 MAC 读取，保持测试确定性
        reverseLookup: async () => undefined,
        resolveMac: () => undefined,
      });
      const used = result.records.find((r) => r.ip === '127.0.0.1');
      const other = result.records.find((r) => r.ip === '127.0.0.2');
      assert.equal(used?.status, 'used');
      assert.deepEqual(used?.openPorts, [18111, 18222]);
      assert.equal(other?.status, 'free');
      assert.equal(other?.openPorts, undefined);
    } finally {
      for (const s of servers) s.close();
    }
  });

  it('mutex prevents concurrent scans of the same subnet', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '192.168.99.0/30', 'sub-test2'));
    });
    const slow = async (ip: string) => {
      await new Promise((r) => setTimeout(r, 30));
      return { ip, alive: false, scannedAt: new Date().toISOString() };
    };
    const first = scanSubnet(makeSubnet('lab', '192.168.99.0/30', 'sub-test2'), { probe: slow });
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(
      scanSubnet(makeSubnet('lab', '192.168.99.0/30', 'sub-test2'), { probe: slow }),
      /SCAN_IN_PROGRESS/,
    );
    await first;
    assert.equal(isScanning('sub-test2'), false);
  });

  it('persists scan results in store after completion', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '10.10.10.0/30', 'sub-test3'));
    });
    const result = await scanSubnet(
      makeSubnet('lab', '10.10.10.0/30', 'sub-test3'),
      {
        probe: async (ip) => ({
          ip,
          alive: true,
          mac: 'aa:bb:cc:dd:ee:ff',
          hostname: 'h',
          responseMs: 7,
          source: 'tcp/80',
          scannedAt: new Date().toISOString(),
        }),
      },
    );
    const stored = await read((data) => data.addresses['sub-test3']);
    assert.ok(stored);
    assert.equal(Object.keys(stored!).length, 2);
    const subnet = await read((data) => data.subnets.find((s) => s.id === 'sub-test3'));
    assert.equal(subnet!.lastScanStatus, 'completed');
    assert.ok(subnet!.lastScanAt);
    const jobs = await read((data) => data.jobs);
    assert.ok(jobs.some((j) => j.id === result.jobId && j.status === 'completed'));
  });

  it('failJob records failure and updates subnet', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '10.10.10.0/30', 'sub-test4'));
      data.jobs.push({ id: 'job-x', subnetId: 'sub-test4', status: 'running', startedAt: new Date().toISOString(), progress: { done: 0, total: 2 } });
    });
    await failJob('sub-test4', 'job-x', 'boom');
    const sub = await read((data) => data.subnets.find((s) => s.id === 'sub-test4'));
    assert.equal(sub!.lastScanStatus, 'failed');
    assert.equal(sub!.lastScanError, 'boom');
    const job = await read((data) => data.jobs.find((j) => j.id === 'job-x'));
    assert.equal(job!.status, 'failed');
    assert.equal(job!.error, 'boom');
  });

  it('detects duplicate MAC across IPs as conflict', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '172.16.0.0/29', 'sub-test5'));
    });
    const result = await scanSubnet(
      makeSubnet('lab', '172.16.0.0/29', 'sub-test5'),
      {
        probe: async (ip) => ({
          ip,
          alive: true,
          mac: 'aa:bb:cc:00:00:01',
          hostname: 'h',
          responseMs: 5,
          source: 'tcp/80',
          scannedAt: new Date().toISOString(),
        }),
      },
    );
    assert.ok(result.conflict >= 2);
  });

  it('currentJobId is available synchronously after scanSubnet returns', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '192.168.99.0/30', 'sub-test-jobid'));
    });
    const promise = scanSubnet(makeSubnet('lab', '192.168.99.0/30', 'sub-test-jobid'), {
      probe: async (ip) => ({ ip, alive: false, scannedAt: new Date().toISOString() }),
    });
    // Immediately after the call returns, currentJobId must already be set.
    assert.ok(currentJobId('sub-test-jobid'), 'currentJobId should be set synchronously');
    assert.equal(isScanning('sub-test-jobid'), true);
    await promise;
    assert.equal(isScanning('sub-test-jobid'), false);
    assert.equal(currentJobId('sub-test-jobid'), undefined);
  });

  it('records per-IP probe errors as free with note; persists via failJob on hard failure', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '10.20.0.0/30', 'sub-test-fail'));
    });
    // Per-IP probe exceptions are caught and recorded as free with an error note
    // — they should not abort the scan.
    await scanSubnet(makeSubnet('lab', '10.20.0.0/30', 'sub-test-fail'), {
      probe: async () => { throw new Error('probe crashed'); },
    });
    const sub = await read((data) => data.subnets.find((s) => s.id === 'sub-test-fail'));
    assert.equal(sub!.lastScanStatus, 'completed');
    const addrs = await read((data) => data.addresses['sub-test-fail']);
    assert.ok(addrs);
    for (const ip of ['10.20.0.1', '10.20.0.2']) {
      assert.equal(addrs![ip].status, 'free');
      assert.match(addrs![ip].note ?? '', /probe crashed/);
    }
    // Explicit failJob() should persist failed status and timestamp.
    await failJob('sub-test-fail', 'job-x', 'manual failure');
    const sub2 = await read((data) => data.subnets.find((s) => s.id === 'sub-test-fail'));
    assert.equal(sub2!.lastScanStatus, 'failed');
    assert.equal(sub2!.lastScanError, 'manual failure');
    assert.ok(sub2!.lastScanAt);
  });

  it('retry recovers when first probe attempt fails', async () => {
    await withWrite((data) => {
      data.subnets.push(makeSubnet('lab', '172.16.0.0/30', 'sub-test6'));
    });
    const perIp = new Map<string, number>();
    const result = await scanSubnet(
      makeSubnet('lab', '172.16.0.0/30', 'sub-test6'),
      {
        retries: 2,
        probe: async (ip) => {
          const n = (perIp.get(ip) ?? 0) + 1;
          perIp.set(ip, n);
          // succeed only on the second attempt for each ip
          return {
            ip,
            alive: n >= 2,
            responseMs: 3,
            source: 'tcp/80',
            mac: ip === '172.16.0.1' ? 'aa:bb:cc:00:00:10' : 'aa:bb:cc:00:00:11',
            scannedAt: new Date().toISOString(),
          };
        },
      },
    );
    assert.equal(result.used, 2);
    assert.equal(result.conflict, 0);
    assert.ok(perIp.get('172.16.0.1')! >= 2);
    assert.ok(perIp.get('172.16.0.2')! >= 2);
  });
});
