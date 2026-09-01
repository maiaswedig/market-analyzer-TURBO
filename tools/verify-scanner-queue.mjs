import assert from 'node:assert/strict';
import { RateQueue } from '../js/util.js';

const queue = new RateQueue(1000, 3);
let active = 0;
let maxActive = 0;
const finished = [];

await Promise.all(Array.from({ length: 8 }, (_, index) => queue.add(async () => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 20));
  finished.push(index);
  active -= 1;
  return index;
})));

assert.equal(maxActive, 3, 'a fila deve sobrepor até três requisições lentas');
assert.equal(finished.length, 8, 'nenhum trabalho pode ser perdido');
assert.equal(active, 0, 'a fila deve terminar sem trabalho ativo');

console.log('Scanner queue: 3/3 verificações passaram.');
