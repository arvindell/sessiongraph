import * as THREE from 'three';
import type { GraphNode } from './types';
import { nodeColor } from './node-appearance';

export function orbArrivals(nodes: GraphNode[], centers: Float32Array, reveals: Float32Array, uniforms: Record<string, THREE.IUniform>) {
  const strip = new THREE.PlaneGeometry(2, 2), geometry = new THREE.InstancedBufferGeometry();
  geometry.index = strip.index; geometry.attributes = strip.attributes; geometry.instanceCount = nodes.length;
  const center = new THREE.InstancedBufferAttribute(centers, 3).setUsage(THREE.DynamicDrawUsage);
  const reveal = new THREE.InstancedBufferAttribute(reveals, 1).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('center', center); geometry.setAttribute('reveal', reveal);
  geometry.setAttribute('color', new THREE.InstancedBufferAttribute(Float32Array.from(nodes.flatMap(node => nodeColor(node).toArray())), 3));
  geometry.setAttribute('radius', new THREE.InstancedBufferAttribute(Float32Array.from(nodes.map(node => node.radius)), 1));
  geometry.setAttribute('nodeIndex', new THREE.InstancedBufferAttribute(Float32Array.from(nodes.map((_, index) => index)), 1));
  const mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
    uniforms, vertexColors: true, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    vertexShader: `attribute vec3 center; attribute float reveal,radius; uniform float uPixelScale,uPixelRatio,uNodeScale;
      varying vec3 vColor; varying vec2 vPoint; varying float vAlpha;
      void main(){
        vColor=color; vPoint=position.xy; vAlpha=max(0.,sin(reveal*3.14159));
        if(reveal<=0. || reveal>=1.) { gl_Position=vec4(2.,2.,2.,1.); return; }
        vec4 mv=modelViewMatrix*vec4(center,1.);
        float size=max(radius*uNodeScale*1.8,-mv.z/uPixelScale*4.*uPixelRatio);
        mv.xy+=position.xy*size;
        gl_Position=projectionMatrix*mv;
      }`,
    fragmentShader: `varying vec3 vColor; varying vec2 vPoint; varying float vAlpha; uniform float uFocus;
      void main(){
        float d=length(vPoint); if(d>=1.) discard;
        float core=exp(-d*d*22.);
        float sparkle=exp(-abs(vPoint.x*vPoint.y)*90.)*pow(max(0.,1.-d),2.);
        gl_FragColor=vec4(mix(vColor,vec3(1.),.65),(core*.18+sparkle*.16)*vAlpha*mix(1.,.16,uFocus));
      }`,
  }));
  mesh.frustumCulled = false;
  return { mesh, update() { center.needsUpdate = true; reveal.needsUpdate = true; } };
}
