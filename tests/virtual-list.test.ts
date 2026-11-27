import test from 'node:test';
import assert from 'node:assert/strict';
import { RowHeights } from '@sessiongraph/core/virtual-list';

test('variable row offsets retain every row at boundaries, after measurements and at the end', () => {
  const values = Array.from({ length: 2500 }, (_, index) => 20 + index % 100 + .5);
  const heights = new RowHeights(values);
  for (let pass = 0; pass < 3; pass++) {
    let offset = 0;
    for (let i = 0; i < values.length; i++) {
      assert.equal(heights.offset(i), offset);
      assert.equal(heights.indexAt(offset), i);
      assert.equal(heights.indexAt(offset + values[i] - .01), i);
      offset += values[i];
    }
    assert.equal(heights.offset(values.length), offset);
    assert.equal(heights.indexAt(offset + 1000), values.length - 1);
    for (let i = pass; i < values.length; i += 7) { values[i] = 30 + (i * 31 + pass * 17) % 90 + .25; heights.set(i, values[i]); }
  }
  assert.equal(heights.indexAt(-100), 0);
  assert.equal(new RowHeights([]).offset(0), 0);
  assert.equal(new RowHeights([]).indexAt(0), 0);
});
