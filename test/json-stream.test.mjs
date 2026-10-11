import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonArrayStream, quoteBareKeys, parseLenient, parseArrayText } from '../src/lib/json-stream.js';

function collect(text, chunkSize) {
  const out = [];
  const s = new JsonArrayStream((src) => out.push(src));
  for (let i = 0; i < text.length; i += chunkSize) s.push(text.slice(i, i + chunkSize));
  s.end();
  return out;
}

test('splits a top-level array into element texts across any chunk size', () => {
  const doc = '[ {"a":1,"s":"x\\"}y"}, {"b":[1,2,{"c":"]"}]}, 3, "str", {"d":"\\\\"} ]';
  const expected = ['{"a":1,"s":"x\\"}y"}', '{"b":[1,2,{"c":"]"}]}', '3', '"str"', '{"d":"\\\\"}'];
  for (const size of [1, 2, 3, 5, 7, 64, 1000]) {
    assert.deepEqual(collect(doc, size), expected, `chunk size ${size}`);
  }
});

test('emits a single top-level object once', () => {
  assert.deepEqual(collect(' {"x":{"y":[1]}} ', 4), ['{"x":{"y":[1]}}']);
});

test('handles a BOM and empty arrays', () => {
  assert.deepEqual(collect('﻿[]', 1), []);
});

test('quotes bare numeric keys outside strings only', () => {
  const src = '{"partTimeMap":{1.0:868.0,2.0:1730},"attribute":"tp=lbs;k=1;{1.0:2}","n":-3}';
  const fixed = quoteBareKeys(src);
  assert.equal(
    fixed,
    '{"partTimeMap":{"1.0":868.0,"2.0":1730},"attribute":"tp=lbs;k=1;{1.0:2}","n":-3}',
  );
  assert.deepEqual(JSON.parse(fixed).partTimeMap, { '1.0': 868, '2.0': 1730 });
});

test('parseLenient falls back to quoting keys', () => {
  assert.deepEqual(parseLenient('{1:2}'), { 1: 2 });
  assert.throws(() => parseLenient('{oops}'));
});

test('parseArrayText counts unparseable elements', () => {
  const values = [];
  const res = parseArrayText('[{"a":1},{bad},{"b":{3.5:1}}]', (v) => values.push(v));
  assert.equal(res.count, 3);
  assert.equal(res.errors, 1);
  assert.deepEqual(values, [{ a: 1 }, { b: { 3.5: 1 } }]);
});
