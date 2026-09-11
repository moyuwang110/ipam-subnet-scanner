// Set env BEFORE any module that depends on DATA_DIR is imported.
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';

const TMP_DIR = path.join(os.tmpdir(), `ipam-api-test-${randomUUID()}`);
process.env.IPAM_DATA_DIR = TMP_DIR;
process.env.IPAM_DISABLE_AUTOSTART = '1';
await fs.mkdir(TMP_DIR, { recursive: true });
await fs.writeFile(path.join(TMP_DIR, 'ipam.json'), JSON.stringify({ subnets: [], addresses: {}, jobs: [] }));

import assert from 'node:assert/strict';
const { describe, it, beforeEach, after } = await import('node:test');
const { buildServer }: typeof import('../src/server/index.js') = await import('../src/server/index.js');
const { withWrite, DATA_FILE }: typeof import('../src/server/store.js') = await import('../src/server/store.js');

async function startServer() {
  const app = buildServer();
  await app.ready();
  return app;
}

describe('api', () => {
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

  it('serves the SPA index for /', async () => {
    const app = await startServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/' });
      assert.equal(res.statusCode, 200);
      assert.match(String(res.headers['content-type']), /text\/html/);
      assert.match(res.body, /IPAM/);
    } finally {
      await app.close();
    }
  });

  it('returns 200 health', async () => {
    const app = await startServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/health' });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
    } finally {
      await app.close();
    }
  });

  it('creates a subnet and rejects invalid CIDR', async () => {
    const app = await startServer();
    try {
      const bad = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'x', cidr: 'not-a-cidr' } });
      assert.equal(bad.statusCode, 400);
      assert.equal(bad.json().error, 'INVALID_CIDR');

      const ok = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'lab', cidr: '10.0.0.0/24', description: 'lab' } });
      assert.equal(ok.statusCode, 201);
      assert.equal(ok.json().subnet.cidr, '10.0.0.0/24');
      assert.equal(ok.json().subnet.mask, '255.255.255.0');
      assert.equal(ok.json().subnet.prefix, 24);

      const dup = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'lab2', cidr: '10.0.0.0/24' } });
      assert.equal(dup.statusCode, 409);
      assert.equal(dup.json().error, 'DUPLICATE_CIDR');
    } finally {
      await app.close();
    }
  });

  it('lists subnets with summaries', async () => {
    const app = await startServer();
    try {
      await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.1.0.0/30' } });
      await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'b', cidr: '10.2.0.0/29' } });
      const res = await app.inject({ method: 'GET', url: '/api/subnets' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.subnets.length, 2);
      const a = body.subnets.find((s: any) => s.subnet.name === 'a');
      assert.equal(a.total, 2);
    } finally {
      await app.close();
    }
  });

  it('updates and toggles a subnet', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.5.0.0/24' } });
      const id = created.json().subnet.id;
      const upd = await app.inject({ method: 'PUT', url: `/api/subnets/${id}`, payload: { name: 'renamed', enabled: false } });
      assert.equal(upd.statusCode, 200);
      assert.equal(upd.json().subnet.name, 'renamed');
      assert.equal(upd.json().subnet.enabled, false);

      const toggle = await app.inject({ method: 'POST', url: `/api/subnets/${id}/toggle` });
      assert.equal(toggle.json().subnet.enabled, true);
    } finally {
      await app.close();
    }
  });

  it('deletes a subnet', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.6.0.0/24' } });
      const id = created.json().subnet.id;
      const del = await app.inject({ method: 'DELETE', url: `/api/subnets/${id}` });
      assert.equal(del.statusCode, 200);
      const list = await app.inject({ method: 'GET', url: '/api/subnets' });
      assert.equal(list.json().subnets.length, 0);
    } finally {
      await app.close();
    }
  });

  it('returns 404 for unknown subnet', async () => {
    const app = await startServer();
    try {
      const res = await app.inject({ method: 'GET', url: '/api/subnets/sub-nope' });
      assert.equal(res.statusCode, 404);
      assert.equal(res.json().error, 'SUBNET_NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('refuses to scan disabled subnet', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.7.0.0/24' } });
      const id = created.json().subnet.id;
      await app.inject({ method: 'PUT', url: `/api/subnets/${id}`, payload: { enabled: false } });
      const res = await app.inject({ method: 'POST', url: `/api/subnets/${id}/scan` });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json().error, 'SUBNET_DISABLED');
    } finally {
      await app.close();
    }
  });

  it('POST /scan returns jobId synchronously and includes it on conflict', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.9.0.0/30' } });
      const id = created.json().subnet.id;
      // inject a slow probe so the scan stays running while we observe jobId
      const { scanSubnet } = await import('../src/server/scanner.js');
      void scanSubnet({ ...created.json().subnet, enabled: true } as any, {
        probe: async (ip: string) => {
          await new Promise((r) => setTimeout(r, 200));
          return { ip, alive: false, scannedAt: new Date().toISOString() };
        },
      });
      // wait briefly for scanSubnet to publish its jobId
      await new Promise((r) => setTimeout(r, 5));
      const res = await app.inject({ method: 'POST', url: `/api/subnets/${id}/scan` });
      assert.equal(res.statusCode, 409);
      const body = res.json();
      assert.equal(body.error, 'SCAN_IN_PROGRESS');
      assert.ok(body.jobId && body.jobId.startsWith('job-'), 'jobId should be present on conflict');
    } finally {
      await app.close();
    }
  });

  it('POST /scan returns the just-created jobId without race', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.10.0.0/30' } });
      const id = created.json().subnet.id;
      const res = await app.inject({ method: 'POST', url: `/api/subnets/${id}/scan` });
      assert.equal(res.statusCode, 202);
      const body = res.json();
      assert.ok(body.jobId && body.jobId.startsWith('job-'), 'jobId must be returned synchronously');
      assert.equal(body.status, 'running');
      // wait for the scan to finish (no probe injected -> real TCP probe; just confirm it eventually ends)
      const { isScanning } = await import('../src/server/scanner.js');
      const deadline = Date.now() + 5000;
      while (isScanning(id) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(isScanning(id), false, 'scan should complete within deadline');
    } finally {
      await app.close();
    }
  });

  it('GET /addresses paginates large subnets', async () => {
    const app = await startServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'big', cidr: '10.99.0.0/24' } });
      const id = created.json().subnet.id;
      const res = await app.inject({ method: 'GET', url: `/api/subnets/${id}/addresses?offset=200&limit=10` });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.equal(body.offset, 200);
      assert.equal(body.limit, 10);
      assert.equal(body.total, 254);
      assert.equal(body.records.length, 10);
    } finally {
      await app.close();
    }
  });

  it('starts a scan with injected probe and returns results', async () => {
    const app = await startServer();
    try {
      // patch scanner via a direct module-import call
      const { scanSubnet } = await import('../src/server/scanner.js');
      // start scan with our probe
      const created = await app.inject({ method: 'POST', url: '/api/subnets', payload: { name: 'a', cidr: '10.8.0.0/30' } });
      const id = created.json().subnet.id;
      // run a scan directly with injected probe to populate store
      await scanSubnet({ ...created.json().subnet, enabled: true } as any, {
        probe: async (ip: string) => ({
          ip,
          alive: true,
          mac: ip === '10.8.0.1' ? 'aa:bb:cc:00:00:01' : 'aa:bb:cc:00:00:02',
          hostname: 'h',
          responseMs: 4,
          source: 'tcp/80',
          scannedAt: new Date().toISOString(),
        }),
      });

      const detail = await app.inject({ method: 'GET', url: `/api/subnets/${id}` });
      assert.equal(detail.statusCode, 200);
      const body = detail.json();
      assert.equal(body.summary.used, 2);
      assert.equal(body.records.length, 2);

      const addrs = await app.inject({ method: 'GET', url: `/api/subnets/${id}/addresses?status=used` });
      assert.equal(addrs.statusCode, 200);
      assert.equal(addrs.json().records.length, 2);
    } finally {
      await app.close();
    }
  });
});
