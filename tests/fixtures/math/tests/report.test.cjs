const { test } = require('node:test');
const assert = require('node:assert/strict');
const report = require('../report.cjs');
test('report composes both operations', () => { assert.deepEqual(report(2, 3), { sum: 5, product: 6 }); });
