const { test } = require('node:test');
const assert = require('node:assert/strict');
const multiply = require('../multiply.cjs');
test('multiplies signed operands', () => { assert.equal(multiply(2, 3), 6); assert.equal(multiply(-3, 2), -6); });
