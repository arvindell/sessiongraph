import * as THREE from 'three';
import { hash } from './layout';
import { nodeColor } from './node-appearance';
import { SPIRAL_BASE, SPIRAL_PITCH, SPIRAL_RAMP, SPIRAL_RATE, SPIRAL_WIDTH } from './spiral';
import type { GraphNode } from './types';

type Uniforms = Record<string, THREE.IUniform>;

const shared = `
  uniform float uHeadX; uniform float uGraphReveal; uniform float uContextFocus;
  uniform float uTrailTime; uniform float uTrailFlow; uniform float uTrailSpeed;
  uniform float uTrailOpacity; uniform float uNodeScale; uniform float uPixelScale;
  attribute vec3 origin; attribute float endX; attribute float radius; attribute float seed; attribute float reveal;
  varying vec3 vColor; varying float vAlpha;
  vec3 cometPoint(float t, float head) {
    float distance = (head - origin.x) * t;
    float phase = distance * ${SPIRAL_RATE.toFixed(10)} + seed * ${String(2 * Math.PI)};
    float curl = (${SPIRAL_BASE} + radius * ${SPIRAL_WIDTH}) * smoothstep(0., ${SPIRAL_RAMP.toFixed(1)}, distance);
    return vec3(origin.x + distance, origin.y + cos(phase) * curl, origin.z + sin(phase) * curl);
  }
`;

/** Bucket tessellation by length: smooth long spirals without oversampling tiny sessions. */
export function cometTrails(nodes: GraphNode[], uniforms: Uniforms, indices: ReadonlyMap<string, number>, selected = false) {
  const trails = nodes.filter(node => node.position[0] > node.startPosition[0]);
  const group = new THREE.Group(); group.userData.kind = 'lifetime';
  const batches: ReturnType<typeof cometBatch>[] = [];
  for (const segments of [16, 64, 256, 512]) {
    const batch = trails.filter(node => {
      const required = (node.position[0] - node.startPosition[0]) / SPIRAL_PITCH * 32;
      return (required <= 16 ? 16 : required <= 64 ? 64 : required <= 256 ? 256 : 512) === segments;
    });
    if (batch.length) {
      const result = cometBatch(batch, uniforms, indices, selected, segments);
      batches.push(result); group.add(result.group);
    }
  }
  return { group, update(reveals: Float32Array) { for (const batch of batches) batch.update(reveals); } };
}

function cometBatch(trails: GraphNode[], uniforms: Uniforms, indices: ReadonlyMap<string, number>, selected: boolean, segments: number) {
  const group = new THREE.Group();
  const nodeIndices = trails.map(node => indices.get(node.session.id)!);
  const materialUniforms = { ...uniforms, uIntensity: { value: selected ? 1 : .48 } };
  const origin: number[] = [], ends: number[] = [], radii: number[] = [], seeds: number[] = [], colors: number[] = [];
  for (const node of trails) {
    origin.push(...node.startPosition); ends.push(node.position[0]); radii.push(node.radius); seeds.push(hash(node.session.id)); colors.push(...nodeColor(node).toArray());
  }
  const strip = new THREE.PlaneGeometry(1, 2, segments, 1);
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = strip.index; geometry.attributes = strip.attributes; geometry.instanceCount = trails.length;
  geometry.setAttribute('origin', new THREE.InstancedBufferAttribute(new Float32Array(origin), 3));
  geometry.setAttribute('endX', new THREE.InstancedBufferAttribute(new Float32Array(ends), 1));
  geometry.setAttribute('radius', new THREE.InstancedBufferAttribute(new Float32Array(radii), 1));
  geometry.setAttribute('seed', new THREE.InstancedBufferAttribute(new Float32Array(seeds), 1));
  geometry.setAttribute('color', new THREE.InstancedBufferAttribute(new Float32Array(colors), 3));
  const reveal = new THREE.InstancedBufferAttribute(new Float32Array(trails.length), 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('reveal', reveal);
  const material = new THREE.ShaderMaterial({
    uniforms: materialUniforms, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `${shared}
      varying float vAcross; varying float vAlong;
      void main() {
        float head = clamp(uHeadX, origin.x, endX), span = head - origin.x;
        float t = uv.x; vAlong = t; vAcross = position.y;
        vColor = color; vAlpha = step(.0001, span) * smoothstep(.45,1.,reveal) * uGraphReveal * mix(1.0, .12, uContextFocus);
        vec3 point = cometPoint(t, head);
        vec4 mv = modelViewMatrix * vec4(point, 1.0);
        vec3 tangent = cometPoint(min(1., t + .001), head) - cometPoint(max(0., t - .001), head);
        vec2 axis = (modelViewMatrix * vec4(tangent,0.)).xy;
        vec2 normal = length(axis) > .001 ? normalize(vec2(-axis.y, axis.x)) : vec2(0.,1.);
        float taper = pow(max(0., t), 1.25);
        float width = (.012 + radius * uNodeScale * .55 * taper) * smoothstep(0., .06, t);
        mv.xy += normal * position.y * width;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `uniform float uTrailOpacity; uniform float uIntensity;
      varying vec3 vColor; varying float vAlpha; varying float vAcross; varying float vAlong;
      void main() {
        float core = exp(-abs(vAcross) * 7.0), halo = pow(max(0., 1.-abs(vAcross)), 2.);
        // Interpolation can put the first ribbon pixels just below zero.
        // Fractional pow of that value poisons the HDR buffer and every bloom mip.
        float along = clamp(vAlong, 0., 1.);
        float tail = smoothstep(0., .04, along) * (.18 + .82 * pow(along, .7));
        float alpha = (core * .8 + halo * .28) * tail * vAlpha * uTrailOpacity * uIntensity;
        gl_FragColor = vec4(vColor * (1.1 + core * .35), alpha);
      }`,
  });
  const ribbon = new THREE.Mesh(geometry, material); ribbon.frustumCulled = false; group.add(ribbon);

  const particles = new THREE.BufferGeometry();
  const positions: number[] = [], particleOrigins: number[] = [], particleEnds: number[] = [], particleRadii: number[] = [], particleSeeds: number[] = [], particleColors: number[] = [];
  const particleStarts = [0];
  for (let index = 0; index < trails.length; index++) {
    const count = Math.min(24, Math.max(8, Math.ceil((ends[index] - origin[index * 3]) / 3)));
    for (let p = 0; p < count; p++) {
      positions.push((p + .5) / count, hash(`${seeds[index]}:${p}`), 0);
      particleOrigins.push(...origin.slice(index * 3, index * 3 + 3)); particleEnds.push(ends[index]); particleRadii.push(radii[index]); particleSeeds.push(seeds[index]); particleColors.push(...colors.slice(index * 3, index * 3 + 3));
    }
    particleStarts.push(positions.length / 3);
  }
  for (const [name, values, size] of [
    ['position', positions, 3], ['origin', particleOrigins, 3], ['endX', particleEnds, 1],
    ['radius', particleRadii, 1], ['seed', particleSeeds, 1], ['color', particleColors, 3],
  ] as const) particles.setAttribute(name, new THREE.Float32BufferAttribute(values, size));
  const particleReveal = new THREE.BufferAttribute(new Float32Array(positions.length / 3), 1).setUsage(THREE.DynamicDrawUsage);
  particles.setAttribute('reveal', particleReveal);
  const sparks = new THREE.Points(particles, new THREE.ShaderMaterial({
    uniforms: materialUniforms, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: `${shared}
      void main() {
        float head = clamp(uHeadX, origin.x, endX), span = head - origin.x;
        float clock = uTrailTime * uTrailFlow * uTrailSpeed;
        float t = fract(position.x - clock * .12 + seed);
        float wake = min(span, 24. + radius * 16.);
        float age = 1. - t;
        float angle = age * 10. + seed * 6.28318 + clock * .5;
        float spread = sin(age * 3.14159) * radius * uNodeScale * (.25 + position.y * .65);
        vec3 point = cometPoint(1. - wake * age / max(.001, span), head);
        point.y += cos(angle) * spread; point.z += sin(angle) * spread;
        vec4 mv = modelViewMatrix * vec4(point, 1.);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp((.045 + radius * .15 * pow(t, .8)) * uPixelScale / max(.1, -mv.z), 1., 7.);
        vColor = color;
        vAlpha = step(.001, span) * smoothstep(.45,1.,reveal) * smoothstep(0., .12, span) * pow(t, 1.4) * (.3 + .7 * position.y) * uGraphReveal * mix(1., .1, uContextFocus);
      }`,
    fragmentShader: `uniform float uTrailOpacity; uniform float uIntensity; varying vec3 vColor; varying float vAlpha;
      void main() { float d = length(gl_PointCoord - .5) * 2.; if (d > 1.) discard;
        gl_FragColor = vec4(vColor * 1.7, pow(1.-d, 1.6) * vAlpha * uTrailOpacity * uIntensity); }`,
  }));
  sparks.name = 'comet-particles'; sparks.frustumCulled = false; group.add(sparks);
  return { group, update(reveals: Float32Array) {
    let changed = false;
    for (let index = 0; index < trails.length; index++) {
      const value = reveals[nodeIndices[index]];
      if (reveal.getX(index) === value) continue;
      changed = true; reveal.setX(index, value);
      (particleReveal.array as Float32Array).fill(value, particleStarts[index], particleStarts[index + 1]);
    }
    if (changed) { reveal.needsUpdate = true; particleReveal.needsUpdate = true; }
  } };
}
