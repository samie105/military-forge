/** The results table (results.mjs): dedup, grouping, pooled numbers, head to head. node --test */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asnsByNetwork, cityName, headToHead, networkName, pool, readRuns, table } from './results.mjs';

const run = (id, over = {}) => ({
  id,
  city: 'lagos',
  network: 'mtn',
  isp: '',
  regions: { los: { rtts: [30, 32, null, 31] }, jnb: { rtts: [90, 95, 92, 91] } },
  net: { asn: 29465, asName: 'VCG-AS, NG' },
  ...over,
});

describe('results', () => {
  it('tables reference pings as ref:<id> next to our regions', () => {
    const rows = table([run('a', { refs: { 'aws-eu-west-2': { rtts: [150, 160, null] } } }), run('b')], { refs: true });
    assert.deepEqual(
      rows.map((r) => [r.city, r.network, r.region, r.runs, r.median, r.loss]),
      [['Lagos', 'MTN', 'ref:aws-eu-west-2', 1, 155, (1 / 3) * 100]],
    );
    assert.ok(table([run('a')]).every((r) => !r.region.startsWith('ref:')));
  });
  it('tidies city and network names', () => {
    assert.equal(cityName('  port   harcourt '), 'Port Harcourt');
    assert.equal(cityName('ile-ife'), 'Ile-Ife');
    assert.equal(networkName({ network: 'fibre', isp: ' spectranet ' }), 'Fibre: Spectranet');
    assert.equal(networkName({ network: 'mtn', isp: 'ignored' }), 'MTN');
    assert.equal(networkName({ network: 'nonsense' }), 'Other');
  });

  it('counts a run saved on both boxes once and skips bad lines', () => {
    const line = JSON.stringify(run('a'));
    const { runs, bad } = readRuns([`${line}\nnot json\n`, `${line}\n${JSON.stringify(run('b'))}\n{}\n`]);
    assert.equal(runs.length, 2);
    assert.equal(bad, 2);
  });

  it('pools raw RTTs across runs', () => {
    const p = pool([{ rtts: [10, 20, null, 30] }, { rtts: [40, 50] }]);
    assert.equal(p.runs, 2);
    assert.equal(p.pings, 6);
    assert.equal(p.median, 30);
    assert.equal(p.p95, 50);
    assert.equal(p.loss, (1 / 6) * 100);
    // per run: (10+10)/2 = 10 and 10; averaged
    assert.equal(p.jitter, 10);
  });

  it('groups by city × network × region, Lagos first', () => {
    const rows = table([run('a'), run('b', { city: 'Lagos ' }), run('c', { city: 'Abuja', network: 'glo' })]);
    assert.deepEqual(
      rows.map((r) => [r.city, r.network, r.region, r.runs]),
      [
        ['Abuja', 'Glo', 'los', 1],
        ['Abuja', 'Glo', 'jnb', 1],
        ['Lagos', 'MTN', 'los', 2],
        ['Lagos', 'MTN', 'jnb', 2],
      ],
    );
    const h = headToHead(rows).find((g) => g.city === 'Lagos');
    assert.equal(h.faster, 'los');
    assert.equal(h.by, 91.5 - 31);
  });

  it('lists the ASNs behind each typed network', () => {
    const out = asnsByNetwork([run('a'), run('b'), run('c', { net: { asn: 37148, asName: 'GLOBACOM' } })]);
    assert.deepEqual(out, [{ network: 'MTN', asns: [['AS29465 VCG-AS, NG', 2], ['AS37148 GLOBACOM', 1]] }]);
  });
});
