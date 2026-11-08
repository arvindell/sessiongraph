import test from 'node:test';
import assert from 'node:assert/strict';
import { focusArea, type ScreenRect } from '@sessiongraph/core/focus-area';

const translate = (rect: ScreenRect, x: number, y: number): ScreenRect => ({ left: rect.left + x, right: rect.right + x, top: rect.top + y, bottom: rect.bottom + y });
test('focus framing avoids panels and is invariant to an embedded viewer offset', () => {
  const container = { left: 0, top: 0, right: 1440, bottom: 900 };
  const panels = [
    { left: 24, top: 86, right: 324, bottom: 610 },
    { left: 1096, top: 86, right: 1416, bottom: 610 },
    { left: 395, top: 690, right: 1045, bottom: 876 },
  ];
  const frame = focusArea(container, panels, 80);
  assert.ok(frame.x - frame.width / 2 >= 344);
  assert.ok(frame.x + frame.width / 2 <= 1076);
  assert.ok(frame.y + frame.height / 2 <= 670);
  assert.deepEqual(focusArea(translate(container, 220, 350), panels.map(p => translate(p, 220, 350)), 80), frame);
  assert.ok(focusArea(container, []).width > frame.width);
});

test('narrow viewers focus above bottom sheets and ignore panels outside the container', () => {
  const container = { left: 100, top: 200, right: 490, bottom: 1000 };
  const panels = [{ left: 110, top: 600, right: 480, bottom: 780 }, { left: 110, top: 800, right: 480, bottom: 980 }];
  const frame = focusArea(container, panels);
  assert.ok(frame.y + frame.height / 2 <= 380);
  assert.ok(frame.width >= 300 && frame.height >= 200);
  assert.deepEqual(focusArea(container, [...panels, { left: 800, top: 80, right: 1120, bottom: 620 }]), frame);
});
