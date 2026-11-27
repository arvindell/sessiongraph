import assert from 'node:assert/strict';

const settle = page => page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });

export async function verifySessionList(page, sessions) {
  const ordered = sessions.toSorted((a, b) => b.activity.lastMessageAt - a.activity.lastMessageAt);
  for (const fraction of [0, .5, 1, .25, 0]) {
    await page.evaluate(fraction => {
      const list = document.querySelector('#session-list');
      list.scrollTop = (list.scrollHeight - list.clientHeight) * fraction;
    }, fraction);
    await settle(page);
    const state = await page.evaluate(() => {
      const list = document.querySelector('#session-list'), bounds = list.getBoundingClientRect();
      const wrappers = [...list.querySelectorAll('.virtual-list-row')].map(row => row.getBoundingClientRect()).sort((a, b) => a.top - b.top);
      return {
        cards: list.querySelectorAll('.session-card').length,
        gap: wrappers.some((row, i) => i && Math.abs(row.top - wrappers[i - 1].bottom) > .5),
        covers: wrappers[0].top <= bounds.top + 1 && wrappers.at(-1).bottom >= bounds.bottom - 11,
      };
    });
    assert.ok(state.cards > 0 && state.cards < 35, 'mounted cards remain bounded');
    assert.equal(state.gap, false, 'measured rows have no overlaps or gaps');
    assert.ok(state.covers, 'mounted window covers the viewport');
  }
  await page.locator('.session-card').first().click();
  for (let i = 0; i < 85; i++) await page.keyboard.press('ArrowDown');
  const focus = await page.evaluate(() => {
    const active = document.activeElement, rect = active.getBoundingClientRect(), viewport = document.querySelector('#session-list').getBoundingClientRect();
    return { id: active.dataset.session, visible: rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1, selected: active.getAttribute('aria-pressed') };
  });
  assert.equal(focus.id, ordered[85].id);
  assert.equal(focus.selected, 'true');
  assert.ok(focus.visible, 'keyboard navigation reveals offscreen rows');
  await page.evaluate(() => { const list = document.querySelector('#session-list'); list.scrollTop = list.scrollHeight; });
  await settle(page);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.session), focus.id, 'wheel scrolling retains keyboard focus');
  assert.ok(await page.locator('.session-card').count() < 35);
  await page.keyboard.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.session), ordered[86].id);

  await page.click('#open-settings');
  await page.locator('[data-pref="density"]').selectOption('compact', { force: true });
  await page.click('.settings-done');
  await page.setViewportSize({ width: 1050, height: 800 });
  await settle(page);
  assert.ok(await page.locator('.session-card').count() < 35);
  await page.click('#close-explorer'); await page.click('#toggle-explorer');
  await settle(page);
  assert.ok(await page.locator('.session-card').count() > 0, 'hidden list recovers after reopening');
  await page.click('#open-settings');
  await page.locator('[data-pref="density"]').selectOption('comfortable', { force: true });
  await page.click('.settings-done');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    const select = document.querySelector('#source');
    select.add(new Option('Empty test source', 'empty-test'));
    select.value = 'empty-test'; select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  assert.equal(await page.locator('.session-card').count(), 0);
  assert.match(await page.locator('#session-list').textContent(), /No sessions/);
  await page.evaluate(() => { const select = document.querySelector('#source'); select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await settle(page);
  assert.ok(await page.locator('.session-card').count() > 0, 'empty list repopulates');
  console.log('Verified: virtual windows, row measurements, keyboard navigation, focus retention, density, resizing, hidden and empty lists.');
}

export async function verifyScene(page) {
  const result = await page.evaluate(() => {
    const scene = window.__benchmarkScene;
    scene.setCutoff(1); scene.select(null); scene.renderFrame(0);
    const versions = [scene.nodeMesh.instanceMatrix.version, scene.glowPositions.version];
    scene.dirty = true; scene.renderFrame(0);
    const unchanged = versions[0] === scene.nodeMesh.instanceMatrix.version && versions[1] === scene.glowPositions.version;
    scene.applyPreferences({ ...scene.preferences, nodeScale: 140 }); scene.renderFrame(0);
    const rescaled = scene.nodeMesh.instanceMatrix.version > versions[0];
    scene.applyPreferences({ ...scene.preferences, nodeScale: 100 });
    scene.renderFrame(0); scene.scene.updateMatrixWorld(true); scene.updatePicking();
    const sample = scene.diagnostics().headSamples.find(sample => sample.screen[0] > 0 && sample.screen[0] < 1440 && sample.screen[1] > 0 && sample.screen[1] < 1000);
    const picked = Boolean(sample && scene.nodeGrid.at(...sample.screen).some(candidate => scene.graph.nodes[candidate.index].session.id === sample.id));
    return { unchanged, rescaled, picked };
  });
  assert.ok(result.unchanged, 'uniform-only redraws do not upload node buffers');
  assert.ok(result.rescaled, 'geometry preference changes update node transforms');
  assert.ok(result.picked, 'picking matches rendered 3D centers');
  console.log('Verified: renderer invalidation, scale changes, 3D picking.');
}
