import assert from 'node:assert/strict';
import test from 'node:test';
import { PROXY_MAX_KBPS, proxyVideoArgs } from '../src/matrix.js';

test('the 360° preview proxy is capped so it streams on an ordinary line', () => {
  const args = proxyVideoArgs(30, '30/1');
  const value = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(PROXY_MAX_KBPS, 2500);
  assert.equal(value('-crf'), '30');
  assert.equal(value('-maxrate'), '2500k');
  assert.equal(value('-bufsize'), '5000k');
  assert.equal(value('-g'), '30');
  assert.equal(value('-r'), '30/1');
  assert.equal(value('-c:v'), 'libx264');
});
