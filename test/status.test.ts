import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeProbesToAddresses, detectConflicts, summarize } from '../src/shared/status.js';
import type { RawProbe } from '../src/shared/status.js';
import type { AddressRecord } from '../src/shared/cidr.js';

function probe(ip: string, alive: boolean, opts: Partial<RawProbe> = {}): RawProbe {
  return {
    ip,
    alive,
    mac: opts.mac,
    hostname: opts.hostname,
    responseMs: opts.responseMs,
    source: opts.source ?? (alive ? 'tcp/80' : undefined),
    ports: opts.ports,
    scannedAt: opts.scannedAt ?? '2026-01-01T00:00:00Z',
    error: opts.error,
  };
}

describe('mergeProbesToAddresses', () => {
  it('marks alive hosts as used and captures MAC/hostname', () => {
    const probes = [probe('10.0.0.1', true, { mac: 'aa:bb:cc:dd:ee:01', hostname: 'host-a' })];
    const records = mergeProbesToAddresses(probes);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'used');
    assert.equal(records[0].mac, 'aa:bb:cc:dd:ee:01');
    assert.equal(records[0].hostname, 'host-a');
    assert.equal(records[0].history.length, 1);
  });

  it('marks unresponsive hosts as free', () => {
    const probes = [probe('10.0.0.2', false)];
    const records = mergeProbesToAddresses(probes);
    assert.equal(records[0].status, 'free');
    assert.equal(records[0].history.length, 0);
  });

  it('captures sorted open ports for alive hosts and clears them for free hosts', () => {
    const records = mergeProbesToAddresses([
      probe('10.0.0.1', true, { ports: [8080, 22, 443] }),
      probe('10.0.0.2', false),
    ]);
    assert.deepEqual(records[0].openPorts, [22, 443, 8080]);
    assert.equal(records[0].status, 'used');
    assert.equal(records[1].openPorts, undefined);
    assert.equal(records[1].status, 'free');
  });

  it('detects IP reporting multiple MACs as conflict', () => {
    const probes = [
      probe('10.0.0.1', true, { mac: 'aa:bb:cc:dd:ee:01' }),
      probe('10.0.0.1', true, { mac: '11:22:33:44:55:66' }),
    ];
    const records = mergeProbesToAddresses(probes);
    assert.equal(records[0].status, 'conflict');
    assert.match(records[0].note ?? '', /multiple MACs/);
  });

  it('detects same MAC on multiple IPs in same subnet as conflict', () => {
    const probes = [
      probe('10.0.0.1', true, { mac: 'aa:bb:cc:dd:ee:01' }),
      probe('10.0.0.2', true, { mac: 'aa:bb:cc:dd:ee:01' }),
    ];
    const records = mergeProbesToAddresses(probes);
    assert.equal(records[0].status, 'conflict');
    assert.equal(records[1].status, 'conflict');
  });

  it('does not flag conflict for unique (IP, MAC) pairs', () => {
    const probes = [
      probe('10.0.0.1', true, { mac: 'aa:bb:cc:dd:ee:01' }),
      probe('10.0.0.2', true, { mac: 'aa:bb:cc:dd:ee:02' }),
    ];
    const records = mergeProbesToAddresses(probes);
    assert.equal(records[0].status, 'used');
    assert.equal(records[1].status, 'used');
  });

  it('preserves history across scans and caps at 50 entries', () => {
    const previous: Record<string, AddressRecord> = {
      '10.0.0.1': {
        ip: '10.0.0.1',
        status: 'used',
        mac: 'aa:bb:cc:dd:ee:01',
        history: Array.from({ length: 49 }, (_, i) => ({
          detectedAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}Z`,
          mac: 'aa:bb:cc:dd:ee:01',
        })),
      },
    };
    const probes = [probe('10.0.0.1', true, { mac: 'aa:bb:cc:dd:ee:01' })];
    const records = mergeProbesToAddresses(probes, previous);
    assert.equal(records[0].history.length, 50);
  });
});

describe('detectConflicts (used directly)', () => {
  it('returns input untouched when no conflicts', () => {
    const records: AddressRecord[] = [
      { ip: '10.0.0.1', status: 'used', mac: 'aa:aa', history: [] },
      { ip: '10.0.0.2', status: 'used', mac: 'bb:bb', history: [] },
    ];
    const out = detectConflicts(records);
    assert.equal(out[0].status, 'used');
    assert.equal(out[1].status, 'used');
  });
});

describe('summarize', () => {
  it('counts statuses and computes usage', () => {
    const records: AddressRecord[] = [
      { ip: '1', status: 'used', history: [] },
      { ip: '2', status: 'used', history: [] },
      { ip: '3', status: 'free', history: [] },
      { ip: '4', status: 'unknown', history: [] },
      { ip: '5', status: 'conflict', history: [] },
    ];
    const s = summarize(records, 10);
    assert.equal(s.total, 10);
    assert.equal(s.used, 2);
    assert.equal(s.free, 1);
    assert.equal(s.unknown, 1);
    assert.equal(s.conflict, 1);
    assert.equal(s.usage, 0.2);
  });
});
