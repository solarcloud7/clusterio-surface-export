const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deflateSync, inflateSync } = require('node:zlib');
const { normalizeSectionExport, prepareSectionImport } = require('../dist/node/lib/section-codec');
const zip = value => deflateSync(JSON.stringify(value)).toString('base64');
const unzip = value => JSON.parse(inflateSync(Buffer.from(value, 'base64')));

test('sections preserve every field, cargo quality, lane identity and false values', async () => {
  const data = { entities: [], tiles: [], belt_side_groups: [], platform: { name: 'Étoile', schedule: {} },
    verification: { item_counts: { 'iron-plate:rare': 123 }, fluid_counts: {} }, empty: {}, disabled: false };
  for (let i = 0; i < 1000; i++) data.entities.push({ id: i, direction: i % 8, inventory: 'x'.repeat(100), lane: i % 2 });
  const original = { compressed: true, payload: zip(data), _transferId: '123:job-1', _targetPlanet: 'nauvis' };
  const transport = await prepareSectionImport(original);
  assert.equal(transport.section_codec, 1);
  assert.ok(transport.sections.length > 2);
  assert.equal(transport._transferId, original._transferId);
  for (const frame of transport.sections) assert.ok(inflateSync(Buffer.from(frame, 'base64')).length <= 65536);
  const artifact = await normalizeSectionExport(transport);
  assert.deepEqual(unzip(artifact.payload), data);
  assert.equal(artifact.compression, 'deflate');
  assert.equal(artifact.section_codec, undefined, 'internal frames escaped into downloadable format');
});

test('legacy artifacts and oversized individual records retain the legacy path', async () => {
  const original = { compressed: true, payload: zip({ entities: [{ inventory: 'x'.repeat(70000) }] }) };
  assert.equal(await prepareSectionImport(original), original);
  assert.equal(await normalizeSectionExport(original), original);
});

test('missing, duplicate, reordered, malformed and oversized frames cannot become artifacts', async () => {
  const frames = [
    { version: 1, seq: 1, key: 'entities', first: 1, values: [{ name: 'belt' }] },
    { version: 1, seq: 2, key: 'entities', first: 2, values: [{ name: 'belt2' }] },
  ];
  for (const bad of [[], [frames[1]], [frames[0], frames[0]], [...frames].reverse(),
    [frames[0], { ...frames[1], first: 3 }], [{ ...frames[0], values: [null] }],
    [{ version: 1, seq: 1, key: 'x' }], [{ version: 1, seq: 1, key: 'x', value: 'a'.repeat(70000) }]]) {
    await assert.rejects(normalizeSectionExport({ section_codec: 1, section_count: bad.length, sections: bad.map(zip) }));
  }
  await assert.rejects(normalizeSectionExport({ section_codec: 9, sections: [zip(frames[0])] }));
  await assert.rejects(normalizeSectionExport({ section_codec: 1, section_count: 1, sections: ['not base64'] }));
});
