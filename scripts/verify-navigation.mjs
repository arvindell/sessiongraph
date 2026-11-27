import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';

// Bundled only by benchmark-navigation --verify, never in the shipped app.
export function verifyNavigation(scene) {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const original = { preferences: { ...scene.preferences }, manual: scene.options.manual, render: scene.composer.render };
  let draws = 0;
  scene.composer.render = function (...args) { draws++; return original.render.apply(this, args); };
  const wheel = () => {
    const position = scene.camera.position.clone(), version = scene.nodeMesh.instanceMatrix.version, before = draws;
    scene.renderer.domElement.dispatchEvent(new WheelEvent('wheel', { deltaY: -45, bubbles: true, cancelable: true }));
    scene.renderFrame(1 / 60);
    check(position.distanceTo(scene.camera.position) > 0, 'wheel changes camera position');
    check(draws === before + 1, 'wheel renders immediately');
    check(scene.nodeMesh.instanceMatrix.version > version && scene.pickingDirty, 'wheel updates camera-facing geometry and picking');
  };
  const pixels = () => {
    const source = scene.renderer.domElement, canvas = document.createElement('canvas');
    canvas.width = source.width; canvas.height = source.height;
    const context = canvas.getContext('2d');
    context.drawImage(source, 0, 0);
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  };
  const comparisons = [];
  try {
    scene.select(null);
    scene.applyPreferences({ ...original.preferences, motion: 'off', quality: 'balanced' });
    for (const flat of [false, true]) for (const damping of [false, true]) {
      scene.setFlat(flat); scene.controls.enableDamping = damping;
      scene.renderFrame(1);
      wheel();
      check(!scene.smaa.enabled && !scene.bloom.enabled, 'balanced movement defers fullscreen effects');
      scene.controls.enableDamping = false; scene.controls.update(); scene.renderFrame(1 / 60);
      const before = draws;
      scene.renderFrame(.2);
      check(scene.smaa.enabled && scene.bloom.enabled && draws === before + 1, 'settling restores effects with a final redraw');
      scene.renderFrame(.2);
      check(draws === before + 1, 'idle scene stops drawing after refinement');
    }
    for (const quality of ['performance', 'high', 'balanced']) for (const view of ['3d', '2d']) {
      scene.applyPreferences({ ...scene.preferences, quality, view });
      scene.reset(); scene.renderFrame(1); wheel();
      const samples = quality === 'performance' ? 0 : Math.min(quality === 'high' ? 4 : 2, scene.renderer.capabilities.maxSamples);
      check(scene.scenePass.target.samples === samples, 'geometry keeps the requested MSAA');
      check(scene.composer.renderTarget1.samples === 0 && scene.composer.renderTarget2.samples === 0, 'postprocessing is single-sample');
      check(scene.composer.readBuffer.depthBuffer === (samples === 0), 'direct geometry rendering retains depth');
      if (quality === 'high') check(scene.smaa.enabled && scene.bloom.enabled, 'high quality retains effects while moving');
      scene.renderFrame(.2);
      check(scene.smaa.enabled === (quality !== 'performance') && scene.bloom.enabled === (quality !== 'performance'), 'settled effects respect quality');

      // Compare the real graph against the original multisampled composer at
      // the exact same camera/time. Shared effect passes preserve shader inputs.
      scene.dirty = true; scene.renderFrame(0);
      const actual = pixels(), bloomWidth = scene.bloom.renderTargetBright.width * 2, bloomHeight = scene.bloom.renderTargetBright.height * 2;
      const reference = new EffectComposer(scene.renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples }));
      reference.setSize(scene.width, scene.height);
      reference.addPass(new RenderPass(scene.scene, scene.camera));
      for (const pass of scene.composer.passes.slice(1)) reference.addPass(pass);
      scene.bloom.setSize(bloomWidth, bloomHeight);
      reference.render();
      const expected = pixels();
      let total = 0, visible = 0;
      for (let i = 0; i < actual.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) total += Math.abs(actual[i + channel] - expected[i + channel]);
        if (actual[i] > 40 || actual[i + 1] > 40 || actual[i + 2] > 40) visible++;
      }
      const meanChannelError = total / (actual.length / 4 * 3);
      comparisons.push({ quality, view, meanChannelError, visiblePixels: visible });
      reference.dispose();
      check(visible > 100, 'comparison contains visible graph geometry');
      check(meanChannelError < .1, `settled ${quality}/${view} pixels match the original pipeline (mean error ${meanChannelError})`);
    }
    scene.options.manual = true;
    scene.applyPreferences({ ...scene.preferences, quality: 'balanced', view: '3d' });
    scene.prepareCapture();
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600;
    scene.captureFrame(.5, 1 / 30, canvas.getContext('2d'));
    check(scene.smaa.enabled && scene.bloom.enabled, 'manual capture retains effects while the playback camera moves');
    scene.setPlaying(false); scene.setCutoff(1);
    scene.options.manual = false;
    scene.applyPreferences({ ...scene.preferences, bloom: 0 });
    wheel(); scene.renderFrame(.2);
    check(!scene.bloom.enabled && scene.smaa.enabled, 'settling does not re-enable disabled bloom');
    check(scene.renderer.getContext().getError() === 0, 'rendering leaves no WebGL errors');
    return { comparisons, wheel: 'passed', quality: 'passed', idleRefinement: 'passed', manualCapture: 'passed' };
  } finally {
    scene.options.manual = original.manual; scene.composer.render = original.render;
    scene.applyPreferences(original.preferences);
    // prepareCapture specializes these export-only settings.
    scene.bloom.radius = .4; scene.bloom.threshold = .9;
    if (scene.glowMaterial) { scene.glowMaterial.uniforms.uGlowSize.value = 1; scene.glowMaterial.uniforms.uGlowIntensity.value = 1; }
    scene.reset(); scene.renderFrame(1); scene.renderFrame(1);
  }
}
