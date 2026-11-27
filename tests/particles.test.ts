import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { makeGraph, progressX } from '@sessiongraph/core/layout';
import { crossedMessages, graphFamily, PARTICLE_BUDGETS, particleSample, scrubImpulse } from '@sessiongraph/core/particle-motion';
import { SceneParticles } from '@sessiongraph/core/scene-particles';
import { ForkLinks } from '@sessiongraph/core/fork-links';
import { DEFAULT_PREFERENCES } from '@sessiongraph/core/preferences';
import type { Graph, Session } from '@sessiongraph/core/types';
import type { TimelineSummary } from '@sessiongraph/core/timeline';

const hour = 3_600_000;
const session = (id: string, created: number, extra: Partial<Session> = {}): Session => ({
  id, created, updated: created, title: id, projectID: 'p', directory: '/repo', model: '', provider: '', agent: '',
  cost: null, tokens: null, archived: false,
  activity: { firstMessageAt: created, lastMessageAt: created + hour, userMessages: 3, untimedUserMessages: 0 }, ...extra,
});
const sample = () => makeGraph([
  session('root', hour), session('child', 2 * hour, { parentID: 'root' }),
  session('fork', 2.5 * hour, { forkID: 'child' }), session('nearby', 2.5 * hour + 1),
], []);
const marker = (id: string, time: number | null, extra: Partial<TimelineSummary> = {}): TimelineSummary => ({
  id, time, ordinal: 0, kind: 'message', role: 'user', name: 'Message', timeSource: time === null ? 'unknown' : 'recorded', preview: '', ...extra,
});
function frame(particles: SceneParticles, graph: Graph, time = 0, extra: Partial<Parameters<SceneParticles['update']>[4]> = {}) {
  const camera = new THREE.PerspectiveCamera(45, 1.6, .1, 2500);
  camera.position.set(20, 70, 320); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  return particles.update(time, 1 / 60, camera, new Float32Array(graph.nodes.length).fill(1), {
    motion: true, suspended: false, playing: false, pixelScale: 1000, pixelRatio: 1, width: 960, height: 600, ...extra,
  });
}
const drawable = (particles: SceneParticles, name: string) => particles.group.getObjectByName(name) as THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;

test('particle sampling is bounded, deterministic, spread across the input, and non-mutating', () => {
  const input = Array.from({ length: 10_000 }, (_, index) => index);
  assert.deepEqual(particleSample(input, 4), [0, 2500, 5000, 7500]);
  assert.deepEqual(particleSample(input, 4), particleSample(input, 4));
  assert.deepEqual(particleSample([], 10), []);
  assert.deepEqual(particleSample(input, 0), []);
  assert.deepEqual(particleSample(input, -1), []);
  assert.deepEqual(particleSample([1, 2], 100), [1, 2]);
  assert.equal(input.length, 10_000);
});

test('selection family traverses explicit forks and children, not shared directories or timestamps', () => {
  const graph = sample(), before = structuredClone(graph);
  const family = graphFamily(graph, 'root');
  assert.deepEqual([...family.depths], [['root', 0], ['child', 1], ['fork', 2]]);
  assert.deepEqual(family.edges.map(item => [item.edge.kind, item.depth]), [['child', 0], ['fork', 1]]);
  assert.equal(graphFamily(graph, 'fork').depths.get('root'), 2);
  assert.equal(graphFamily(graph, 'nearby').depths.size, 1);
  assert.equal(graphFamily(graph, 'missing').depths.size, 0);
  assert.equal(graphFamily(graph, 'root', 2).depths.size, 2);
  assert.deepEqual(graph, before);
});

test('family walks are iterative and bounded with deep ancestry, dangling links, and cycles', () => {
  const graph = makeGraph(Array.from({ length: 8000 }, (_, index) => session(String(index), hour + index, { parentID: index ? String(index - 1) : undefined })), []);
  graph.edges.push({ from: '7999', to: '0', kind: 'fork' }, { from: 'outside', to: '0', kind: 'child' });
  const family = graphFamily(graph, '0', 100);
  assert.equal(family.depths.size, 100);
  assert.ok(family.edges.length <= 200);
  assert.equal(family.depths.has('outside'), false);
});

test('time wind is directional, finite, bounded, and ignores invalid or unchanged seeks', () => {
  assert.ok(scrubImpulse(0, 10, .1, 300) > 0);
  assert.ok(scrubImpulse(10, 0, .1, 300) < 0);
  assert.equal(scrubImpulse(0, 300, 0, 300), 1);
  assert.equal(scrubImpulse(300, 0, 0, 300), -1);
  for (const args of [[0, 0, .1, 300], [0, 1, .1, 0], [NaN, 1, .1, 300], [0, 1, Infinity, 300]]) assert.equal(scrubImpulse(...args as [number, number, number, number]), 0);
});

test('message crossings use a half-open interval, remain bounded, and never fire on rewind', () => {
  assert.deepEqual(crossedMessages([1, 2, 2, 3, 4], 1, 3), [2, 2, 3]);
  assert.deepEqual(crossedMessages([1, 2, 3], 3, 1), []);
  assert.deepEqual(crossedMessages([1, 2, 3], 2, 2), []);
  assert.deepEqual(crossedMessages([1, 2, 3], 0, 3, 0), []);
  assert.equal(crossedMessages(Array.from({ length: 100_000 }, (_, i) => i), 0, 100_000, 6).length, 6);
});

test('GPU effects obey per-quality budgets and preserve the entire input graph', () => {
  const graph = makeGraph(Array.from({ length: 1200 }, (_, i) => session(String(i), hour + i * 1000)), []);
  const original = structuredClone(graph);
  for (const quality of ['performance', 'balanced', 'high'] as const) {
    const particles = new SceneParticles();
    try {
      particles.configure({ ...DEFAULT_PREFERENCES, quality }); particles.setGraph(graph);
      particles.births(graph.nodes, 0); frame(particles, graph);
      const budget = PARTICLE_BUDGETS[quality], diagnostics = particles.diagnostics();
      assert.equal(diagnostics.dust, budget.dust);
      assert.ok(diagnostics.energyParticles <= budget.trails * 6);
      assert.equal(drawable(particles, 'fork-bloom-sparks').geometry.getAttribute('position').count, budget.bursts * budget.sparks);
      assert.equal(particles.group.getObjectByName('session-birth-rings'), undefined, 'arrivals keep sparks without expanding birth rings');
      assert.ok(particles.group.children.length <= 8, 'effects are batched, not one mesh per session');
      particles.group.traverse(object => {
        const geometry = (object as THREE.Mesh).geometry;
        if (!geometry) return;
        for (const attr of Object.values(geometry.attributes)) assert.ok(Array.from(attr.array).every(Number.isFinite));
      });
      assert.deepEqual(graph, original);
    } finally { particles.dispose(); }
    assert.equal(particles.group.children.length, 0);
  }
});

test('message energy is triggered only by already-loaded timed conversation events during playback', () => {
  const graph = sample(), particles = new SceneParticles(), node = graph.nodes.find(node => node.session.id === 'root')!;
  try {
    particles.setGraph(graph); particles.select(node);
    particles.events([
      marker('known', 1.2 * hour), marker('untimed', null), marker('unknown-clock', 1.3 * hour, { timeSource: 'unknown' }),
      marker('tool', 1.4 * hour, { kind: 'tool_call' }), marker('commit', 1.5 * hour, { kind: 'commit' }),
      marker('outside', 5 * hour),
    ]);
    particles.seek(progressX(0, graph), progressX(1, graph), false, false);
    assert.equal(particles.diagnostics().messagePackets, 0, 'loading or selection does not replay messages');
    particles.seek(progressX(0, graph), progressX(1, graph), true, false);
    assert.equal(particles.diagnostics().messagePackets, 1);
    frame(particles, graph, .2, { selectedCenter: node.position });
    assert.equal(drawable(particles, 'recorded-message-packets').geometry.drawRange.count, 8);
    particles.seek(progressX(1, graph), progressX(0, graph), true, false);
    assert.equal(particles.diagnostics().messagePackets, 0);
    particles.seek(progressX(0, graph), progressX(1, graph), true, false);
    frame(particles, graph, 2, { selectedCenter: node.position });
    assert.equal(particles.diagnostics().messagePackets, 0, 'old packets expire');
  } finally { particles.dispose(); }
});

test('decorations respect motion, suspension, stars, trails, message visibility, and explicit scrubbing', () => {
  const graph = sample(), particles = new SceneParticles(), node = graph.nodes[0];
  try {
    particles.setGraph(graph);
    assert.equal(frame(particles, graph, 0, { motion: false }), false);
    assert.equal(particles.group.visible, false);
    assert.equal(frame(particles, graph, 0, { suspended: true }), false);
    particles.configure({ ...DEFAULT_PREFERENCES, stars: false, trails: 'off', messageDots: false });
    assert.equal(frame(particles, graph), false, 'no idle work with all relevant layers disabled');
    assert.equal(drawable(particles, 'interactive-stardust').visible, false);
    assert.equal(drawable(particles, 'trail-energy-packets').visible, false);
    particles.seek(-100, 0, true, false);
    frame(particles, graph);
    assert.equal(particles.diagnostics().wind, 0, 'regular playback is not a scrub gesture');
    particles.seek(0, -100, false, true); frame(particles, graph);
    assert.ok(particles.diagnostics().wind < 0);
    frame(particles, graph, 1); particles.reset(); frame(particles, graph, 2);
    assert.equal(particles.diagnostics().wind, 0);
    particles.select(node); frame(particles, graph, 3, { selectedCenter: node.position });
    assert.equal(particles.diagnostics().orbit, true);
    particles.select(); frame(particles, graph, 4);
    assert.equal(particles.diagnostics().orbit, false);
  } finally { particles.dispose(); }
});

test('quality rebuilds preserve selected message timestamps and empty graphs clear every effect', () => {
  const graph = sample(), particles = new SceneParticles(), node = graph.nodes[0];
  try {
    particles.setGraph(graph); particles.select(node); particles.events([marker('message', node.session.created + 100)]);
    particles.configure({ ...DEFAULT_PREFERENCES, quality: 'high' });
    particles.seek(progressX(0, graph), progressX(1, graph), true, false);
    assert.equal(particles.diagnostics().messagePackets, 1);
    particles.setGraph(makeGraph([], []));
    assert.equal(particles.group.children.length, 0);
    assert.equal(frame(particles, makeGraph([], [])), false);
    assert.equal(particles.diagnostics().energyParticles, 0);
    assert.equal(particles.diagnostics().messagePackets, 0);
  } finally { particles.dispose(); }
});

test('fixed-step playback produces deterministic particle state and clears old birth flashes on reset', () => {
  const graph = sample(), first = new SceneParticles(), second = new SceneParticles();
  try {
    for (const particles of [first, second]) {
      particles.setGraph(graph); particles.select(graph.nodes[0]);
      particles.births(graph.nodes, .1); particles.pointer(450, 250, 960, 600);
      for (let index = 0; index < 20; index++) {
        particles.seek(progressX(index / 20, graph), progressX((index + 1) / 20, graph), true, false);
        frame(particles, graph, index / 30, { playing: true, selectedCenter: graph.nodes[0].position });
      }
    }
    assert.deepEqual(first.diagnostics(), second.diagnostics());
    for (const name of ['interactive-stardust', 'fork-bloom-sparks', 'recorded-message-packets']) {
      const a = drawable(first, name).geometry, b = drawable(second, name).geometry;
      for (const key of Object.keys(a.attributes)) assert.deepEqual(a.getAttribute(key).array, b.getAttribute(key).array);
    }
    first.reset();
    const born = drawable(first, 'fork-bloom-sparks').geometry.getAttribute('born');
    assert.ok(Array.from(born.array).every(value => value === -1000));
  } finally { first.dispose(); second.dispose(); }
});

test('selection-family ribbons light up in depth order and reduced motion reveals them immediately', () => {
  const curve = new THREE.CubicBezierCurve3(new THREE.Vector3(), new THREE.Vector3(1, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(3, 0, 0));
  const links = new ForkLinks([
    { curve, color: new THREE.Color('white'), child: 0, delay: 0 },
    { curve, color: new THREE.Color('white'), child: 1, delay: .3 },
  ], { uPixelScale: { value: 1000 }, uPixelRatio: { value: 1 }, uContextFocus: { value: 0 } }, true);
  try {
    links.update(new Float32Array([1, 1]), .2);
    assert.ok(links.samples()[0] > 0);
    assert.equal(links.samples()[1], 0);
    links.update(new Float32Array([1, .5]));
    assert.deepEqual(links.samples(), [1, .5], 'no motion delays when elapsed is omitted');
  } finally {
    links.group.traverse(object => { const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material instanceof THREE.Material) mesh.material.dispose(); });
  }
});
