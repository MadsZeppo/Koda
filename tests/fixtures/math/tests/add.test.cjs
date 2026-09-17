const { test } = require('node:test');
const assert = require('node:assert/strict');
const add = require('../add.cjs');
test('adds signed operands', () => { assert.equal(add(2, 3), 5); assert.equal(add(-3, 1), -2); });
