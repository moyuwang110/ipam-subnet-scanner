import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';
import { withWrite, read } from './store.js';
import { parseCidr, isValidCidr, generateAddresses, type Subnet, type AddressRecord, type SubnetSummary } from '../shared/cidr.js';
import { summarize } from '../shared/status.js';
import { scanSubnet, isScanning, currentJobId } from './scanner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? '0.0.0.0';

export function buildServer() {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

  app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', decorateReply: false });

  app.get('/api/health', async () => ({ ok: true }));

  // Subnet list
  app.get('/api/subnets', async () => {
    return read((data) => {
      const summaries: SubnetSummary[] = data.subnets.map((s) => buildSummary(s, data.addresses[s.id] ?? {}));
      return { subnets: summaries };
    });
  });

  // Subnet detail
  app.get<{ Params: { id: string }; Querystring: { include?: string } }>('/api/subnets/:id', async (req, reply) => {
    const { id } = req.params;
    const includeAll = req.query.include === 'all';
    return read((data) => {
      const subnet = data.subnets.find((s) => s.id === id);
      if (!subnet) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      const addrs = data.addresses[id] ?? {};
      const expected = generateAddresses(subnet.cidr);
      const allRecords: AddressRecord[] = expected.map((ip) => addrs[ip] ?? { ip, status: 'unknown', history: [] });
      const total = expected.length;
      const summary = summarize(allRecords, total);
      if (includeAll) {
        return { subnet, summary, totalAddresses: total, records: allRecords };
      }
      // by default: cap embedded records to 1024 to keep dashboard snappy
      const MAX_EMBED = 1024;
      const records = allRecords.length > MAX_EMBED ? allRecords.slice(0, MAX_EMBED) : allRecords;
      return {
        subnet,
        summary,
        totalAddresses: total,
        records,
        truncated: allRecords.length > MAX_EMBED,
      };
    });
  });

  // Create subnet
  app.post<{ Body: { name: string; cidr: string; description?: string } }>('/api/subnets', async (req, reply) => {
    const { name, cidr, description } = req.body ?? ({} as any);
    if (!name || typeof name !== 'string') {
      reply.code(400);
      return { error: 'INVALID_NAME' };
    }
    if (!cidr || typeof cidr !== 'string' || !isValidCidr(cidr)) {
      reply.code(400);
      return { error: 'INVALID_CIDR', message: 'CIDR is not a valid IPv4 network (e.g. 192.168.1.0/24)' };
    }
    return withWrite((data) => {
      const exists = data.subnets.some((s) => s.cidr === cidr);
      if (exists) {
        reply.code(409);
        return { error: 'DUPLICATE_CIDR', message: `Subnet ${cidr} already exists` };
      }
      const parsed = parseCidr(cidr);
      const now = new Date().toISOString();
      const subnet: Subnet = {
        id: 'sub-' + Math.random().toString(36).slice(2, 10),
        name,
        cidr,
        network: parsed.network,
        prefix: parsed.prefix,
        mask: parsed.mask,
        description,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastScanStatus: 'pending',
      };
      data.subnets.push(subnet);
      reply.code(201);
      return { subnet };
    });
  });

  // Update subnet
  app.put<{ Params: { id: string }; Body: { name?: string; cidr?: string; description?: string; enabled?: boolean } }>('/api/subnets/:id', async (req, reply) => {
    const { id } = req.params;
    const { name, cidr, description, enabled } = req.body ?? ({} as any);
    return withWrite((data) => {
      const subnet = data.subnets.find((s) => s.id === id);
      if (!subnet) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      if (cidr !== undefined) {
        if (!isValidCidr(cidr)) {
          reply.code(400);
          return { error: 'INVALID_CIDR', message: 'CIDR is not a valid IPv4 network' };
        }
        if (data.subnets.some((s) => s.id !== id && s.cidr === cidr)) {
          reply.code(409);
          return { error: 'DUPLICATE_CIDR' };
        }
        const parsed = parseCidr(cidr);
        subnet.cidr = cidr;
        subnet.network = parsed.network;
        subnet.prefix = parsed.prefix;
        subnet.mask = parsed.mask;
        delete data.addresses[id];
      }
      if (name !== undefined) subnet.name = name;
      if (description !== undefined) subnet.description = description;
      if (typeof enabled === 'boolean') subnet.enabled = enabled;
      subnet.updatedAt = new Date().toISOString();
      return { subnet };
    });
  });

  // Delete subnet
  app.delete<{ Params: { id: string } }>('/api/subnets/:id', async (req, reply) => {
    const { id } = req.params;
    return withWrite((data) => {
      const idx = data.subnets.findIndex((s) => s.id === id);
      if (idx < 0) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      data.subnets.splice(idx, 1);
      delete data.addresses[id];
      data.jobs = data.jobs.filter((j) => j.subnetId !== id);
      return { ok: true };
    });
  });

  // Toggle enable/disable
  app.post<{ Params: { id: string } }>('/api/subnets/:id/toggle', async (req, reply) => {
    const { id } = req.params;
    return withWrite((data) => {
      const subnet = data.subnets.find((s) => s.id === id);
      if (!subnet) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      subnet.enabled = !subnet.enabled;
      subnet.updatedAt = new Date().toISOString();
      return { subnet };
    });
  });

  // Start scan
  app.post<{ Params: { id: string } }>('/api/subnets/:id/scan', async (req, reply) => {
    const { id } = req.params;
    if (isScanning(id)) {
      reply.code(409);
      const jobId = currentJobId(id);
      return { error: 'SCAN_IN_PROGRESS', message: 'A scan is already running for this subnet', jobId };
    }
    const subnet = await read((data) => data.subnets.find((s) => s.id === id));
    if (!subnet) {
      reply.code(404);
      return { error: 'SUBNET_NOT_FOUND' };
    }
    if (!subnet.enabled) {
      reply.code(400);
      return { error: 'SUBNET_DISABLED', message: 'Subnet is disabled; enable it before scanning' };
    }
    // Kick off the scan in the background. scanSubnet() reserves the jobId
    // synchronously before its first await, so the ID is available right after
    // the call returns (still in the microtask queue before any I/O).
    const scanPromise = scanSubnet(subnet).catch((err) => {
      app.log.error({ err }, 'scan failed');
    });
    void scanPromise;
    const jobId = currentJobId(id);
    if (!jobId) {
      reply.code(500);
      return { error: 'SCAN_START_FAILED', message: 'Failed to start scan' };
    }
    reply.code(202);
    return { jobId, status: 'running' };
  });

  // Get latest scan job for subnet
  app.get<{ Params: { id: string } }>('/api/subnets/:id/scan', async (req, reply) => {
    const { id } = req.params;
    return read((data) => {
      const subnet = data.subnets.find((s) => s.id === id);
      if (!subnet) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      const jobs = data.jobs.filter((j) => j.subnetId === id);
      const latest = jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
      return { job: latest ?? null, isScanning: isScanning(id) };
    });
  });

  // Get all addresses for a subnet (paged)
  app.get<{ Params: { id: string }; Querystring: { status?: string; offset?: string; limit?: string } }>('/api/subnets/:id/addresses', async (req, reply) => {
    const { id } = req.params;
    const status = (req.query.status ?? '').trim();
    const offset = Math.max(0, Number(req.query.offset ?? 0));
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit ?? 512)));
    return read((data) => {
      const subnet = data.subnets.find((s) => s.id === id);
      if (!subnet) {
        reply.code(404);
        return { error: 'SUBNET_NOT_FOUND' };
      }
      const all = generateAddresses(subnet.cidr);
      const stored = data.addresses[id] ?? {};
      const records: AddressRecord[] = all.map((ip) => stored[ip] ?? { ip, status: 'unknown', history: [] });
      const filtered = status && status !== 'all' ? records.filter((r) => r.status === status) : records;
      const slice = filtered.slice(offset, offset + limit);
      return {
        total: filtered.length,
        offset,
        limit,
        records: slice,
      };
    });
  });

  // Static frontend
  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404);
      return { error: 'NOT_FOUND' };
    }
    try {
      const data = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
      reply.type('text/html');
      return data;
    } catch {
      reply.code(404);
      return { error: 'NOT_FOUND' };
    }
  });

  return app;
}

function buildSummary(subnet: Subnet, stored: Record<string, AddressRecord>): SubnetSummary {
  const ips = generateAddresses(subnet.cidr);
  const total = ips.length;
  const records: AddressRecord[] = ips.map((ip) => stored[ip] ?? { ip, status: 'unknown', history: [] });
  const s = summarize(records, total);
  return { subnet, ...s };
}

if (process.env.NODE_ENV !== 'test' && process.env.IPAM_DISABLE_AUTOSTART !== '1') {
  const app = buildServer();
  app.listen({ port: PORT, host: HOST }).then((addr) => {
    app.log.info(`IPAM listening on http://${addr}`);
  }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
