import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressRecord, Subnet, ScanJob } from '../shared/cidr.js';
import { randomId } from '../shared/cidr.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envDir = process.env.IPAM_DATA_DIR;
export const DATA_DIR = envDir ? path.resolve(envDir) : path.resolve(__dirname, '..', '..', 'data');
export const DATA_FILE = path.join(DATA_DIR, 'ipam.json');

interface DataShape {
  subnets: Subnet[];
  addresses: Record<string, Record<string, AddressRecord>>; // subnetId -> ip -> record
  jobs: ScanJob[];
}

const empty: DataShape = { subnets: [], addresses: {}, jobs: [] };

let cache: DataShape | null = null;
let writeLock: Promise<void> = Promise.resolve();

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function load(): Promise<DataShape> {
  if (cache) return cache;
  await ensureDir();
  try {
    const buf = await fs.readFile(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(buf) as Partial<DataShape>;
    cache = {
      subnets: parsed.subnets ?? [],
      addresses: parsed.addresses ?? {},
      jobs: parsed.jobs ?? [],
    };
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
    cache = JSON.parse(JSON.stringify(empty));
    await persist();
  }
  return cache!;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const data = JSON.stringify(cache, null, 2);
  await ensureDir();
  const tmp = DATA_FILE + '.tmp';
  await fs.writeFile(tmp, data, 'utf-8');
  await fs.rename(tmp, DATA_FILE);
}

export async function withWrite<T>(fn: (data: DataShape) => T | Promise<T>): Promise<T> {
  // serialise writes
  const run = async () => {
    const data = await load();
    const result = await fn(data);
    await persist();
    return result;
  };
  const next = writeLock.then(run, run);
  writeLock = next.then(() => undefined, () => undefined);
  return next;
}

export async function read<T>(fn: (data: DataShape) => T | Promise<T>): Promise<T> {
  const data = await load();
  return fn(data);
}

export function newId(prefix = ''): string {
  return prefix + randomId();
}
