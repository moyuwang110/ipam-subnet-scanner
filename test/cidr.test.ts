import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCidr,
  generateAddresses,
  isValidCidr,
  ipToInt,
  intToIp,
  maskForPrefix,
} from '../src/shared/cidr.js';

describe('cidr', () => {
  it('parses /24 correctly', () => {
    const r = parseCidr('192.168.10.0/24');
    assert.equal(r.network, '192.168.10.0');
    assert.equal(r.prefix, 24);
    assert.equal(r.mask, '255.255.255.0');
    assert.equal(r.start, ipToInt('192.168.10.0'));
    assert.equal(r.end, ipToInt('192.168.10.255'));
  });

  it('parses /30', () => {
    const r = parseCidr('10.0.0.0/30');
    assert.equal(r.network, '10.0.0.0');
    assert.equal(r.mask, '255.255.255.252');
    assert.equal(intToIp(r.start), '10.0.0.0');
    assert.equal(intToIp(r.end), '10.0.0.3');
  });

  it('handles /0 and /32', () => {
    const a = parseCidr('0.0.0.0/0');
    assert.equal(a.mask, '0.0.0.0');
    const b = parseCidr('1.2.3.4/32');
    assert.equal(intToIp(b.start), '1.2.3.4');
    assert.equal(intToIp(b.end), '1.2.3.4');
  });

  it('generates addresses excluding network and broadcast by default', () => {
    const ips = generateAddresses('192.168.1.0/30');
    assert.deepEqual(ips, ['192.168.1.1', '192.168.1.2']);
  });

  it('includes network/broadcast when requested', () => {
    const ips = generateAddresses('192.168.1.0/30', { includeNetwork: true, includeBroadcast: true });
    assert.deepEqual(ips, ['192.168.1.0', '192.168.1.1', '192.168.1.2', '192.168.1.3']);
  });

  it('rejects invalid CIDR', () => {
    assert.equal(isValidCidr('not-a-cidr'), false);
    assert.equal(isValidCidr('256.0.0.0/24'), false);
    assert.equal(isValidCidr('192.168.1.0/33'), false);
    assert.equal(isValidCidr('192.168.1.0'), false);
    assert.equal(isValidCidr(''), false);
  });

  it('maskForPrefix returns correct dotted mask', () => {
    assert.equal(maskForPrefix(8), '255.0.0.0');
    assert.equal(maskForPrefix(16), '255.255.0.0');
    assert.equal(maskForPrefix(23), '255.255.254.0');
    assert.equal(maskForPrefix(0), '0.0.0.0');
    assert.equal(maskForPrefix(32), '255.255.255.255');
  });

  it('generateAddresses for /30 produces 2 usable hosts', () => {
    const ips = generateAddresses('10.1.1.4/30');
    assert.equal(ips.length, 2);
  });

  it('generateAddresses for /29 produces 6 usable hosts', () => {
    const ips = generateAddresses('10.1.1.0/29');
    assert.equal(ips.length, 6);
  });
});
