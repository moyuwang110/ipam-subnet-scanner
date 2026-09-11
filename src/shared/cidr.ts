export type Status = 'used' | 'free' | 'unknown' | 'conflict';

export interface Subnet {
  id: string;
  name: string;
  cidr: string;
  network: string;
  prefix: number;
  mask: string;
  description?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastScanAt?: string;
  lastScanStatus?: 'pending' | 'running' | 'completed' | 'failed';
  lastScanError?: string;
}

export interface AddressRecord {
  ip: string;
  status: Status;
  mac?: string;
  hostname?: string;
  responseMs?: number;
  /** 探测中发现开放的全部 TCP 端口（仅 used 状态） */
  openPorts?: number[];
  discoveredAt?: string;
  source?: string;
  note?: string;
  history: Array<{
    detectedAt: string;
    mac?: string;
    hostname?: string;
    responseMs?: number;
    source?: string;
  }>;
}

export interface ScanJob {
  id: string;
  subnetId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  finishedAt?: string;
  progress: { done: number; total: number };
  error?: string;
}

export interface SubnetSummary {
  subnet: Subnet;
  total: number;
  used: number;
  free: number;
  unknown: number;
  conflict: number;
  usage: number;
}

export interface CidrParseResult {
  network: string;
  prefix: number;
  mask: string;
  start: number;
  end: number;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|[01]?\d?\d)(\.(25[0-5]|2[0-4]\d|[01]?\d?\d)){3}$/;

export function ipToInt(ip: string): number {
  if (!IPV4_RE.test(ip)) throw new Error(`Invalid IPv4 address: ${ip}`);
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function intToIp(n: number): string {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ].join('.');
}

export function maskForPrefix(prefix: number): string {
  if (prefix < 0 || prefix > 32) throw new Error('Prefix out of range');
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(mask);
}

export function parseCidr(cidr: string): CidrParseResult {
  if (typeof cidr !== 'string') throw new Error('CIDR must be a string');
  const trimmed = cidr.trim();
  const idx = trimmed.indexOf('/');
  if (idx < 0) throw new Error('CIDR must contain /');
  const ipPart = trimmed.slice(0, idx);
  const prefixPart = trimmed.slice(idx + 1);
  if (!IPV4_RE.test(ipPart)) throw new Error(`Invalid CIDR address: ${ipPart}`);
  const prefix = Number(prefixPart);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`Invalid prefix: ${prefixPart}`);
  }
  const ipInt = ipToInt(ipPart);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const start = (ipInt & mask) >>> 0;
  const end = (start | (~mask >>> 0)) >>> 0;
  const network = intToIp(start);
  return {
    network,
    prefix,
    mask: maskForPrefix(prefix),
    start,
    end,
  };
}

export function generateAddresses(cidr: string, opts: { includeNetwork?: boolean; includeBroadcast?: boolean } = {}): string[] {
  const parsed = parseCidr(cidr);
  const { start, end } = parsed;
  const total = end - start + 1;
  const result: string[] = [];
  for (let i = start; i <= end; i++) {
    const isNetwork = i === start;
    const isBroadcast = i === end;
    if (isNetwork && !opts.includeNetwork) continue;
    if (isBroadcast && !opts.includeBroadcast) continue;
    result.push(intToIp(i >>> 0));
  }
  return result;
}

export function isValidCidr(cidr: string): boolean {
  try {
    parseCidr(cidr);
    return true;
  } catch {
    return false;
  }
}

export function randomId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
