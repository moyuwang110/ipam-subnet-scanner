import type { AddressRecord, Status } from './cidr.js';

export interface RawProbe {
  ip: string;
  alive: boolean;
  mac?: string;
  hostname?: string;
  responseMs?: number;
  source?: string;
  /** 本次探测中该 IP 开放的全部 TCP 端口 */
  ports?: number[];
  error?: string;
  scannedAt: string;
}

export function mergeProbesToAddresses(probes: RawProbe[], previous?: Record<string, AddressRecord>): AddressRecord[] {
  const prevMap = new Map<string, AddressRecord>();
  if (previous) {
    for (const r of Object.values(previous)) prevMap.set(r.ip, r);
  }
  const records: AddressRecord[] = [];
  for (const p of probes) {
    const prev = prevMap.get(p.ip);
    let status: Status;
    if (!p.alive) {
      status = 'free';
    } else {
      status = 'used';
    }
    const record: AddressRecord = {
      ip: p.ip,
      status,
      mac: p.mac,
      hostname: p.hostname,
      responseMs: p.responseMs,
      openPorts: p.alive && p.ports && p.ports.length > 0 ? [...p.ports].sort((a, b) => a - b) : undefined,
      discoveredAt: p.alive ? p.scannedAt : undefined,
      source: p.alive ? p.source : undefined,
      note: p.error ?? undefined,
      history: prev ? [...prev.history] : [],
    };
    if (p.alive) {
      record.history.push({
        detectedAt: p.scannedAt,
        mac: p.mac,
        hostname: p.hostname,
        responseMs: p.responseMs,
        source: p.source,
      });
      if (record.history.length > 50) record.history.splice(0, record.history.length - 50);
    }
    records.push(record);
  }
  return detectConflicts(records);
}

export function detectConflicts(records: AddressRecord[]): AddressRecord[] {
  const ipToMacs = new Map<string, Set<string>>();
  const macToIps = new Map<string, Set<string>>();

  for (const r of records) {
    if (r.status !== 'used' || !r.mac) continue;
    const mac = r.mac.toLowerCase();
    if (!ipToMacs.has(r.ip)) ipToMacs.set(r.ip, new Set());
    ipToMacs.get(r.ip)!.add(mac);
    if (!macToIps.has(mac)) macToIps.set(mac, new Set());
    macToIps.get(mac)!.add(r.ip);
  }

  for (const r of records) {
    if (r.status !== 'used') continue;
    const macs = ipToMacs.get(r.ip);
    if (macs && macs.size > 1) {
      r.status = 'conflict';
      r.note = `IP ${r.ip} reports multiple MACs: ${[...macs].join(', ')}`;
      continue;
    }
    if (r.mac) {
      const mac = r.mac.toLowerCase();
      const ips = macToIps.get(mac);
      if (ips && ips.size > 1) {
        r.status = 'conflict';
        r.note = `MAC ${r.mac} appears on multiple IPs: ${[...ips].join(', ')}`;
      }
    }
  }
  return records;
}

export function summarize(records: AddressRecord[], total: number): {
  total: number;
  used: number;
  free: number;
  unknown: number;
  conflict: number;
  usage: number;
} {
  let used = 0, free = 0, unknown = 0, conflict = 0;
  for (const r of records) {
    if (r.status === 'used') used++;
    else if (r.status === 'free') free++;
    else if (r.status === 'unknown') unknown++;
    else if (r.status === 'conflict') conflict++;
  }
  const usage = total > 0 ? used / total : 0;
  return { total, used, free, unknown, conflict, usage };
}
