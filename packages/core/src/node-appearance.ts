import * as THREE from 'three';
import { hash } from './layout';

export type FocusUniforms = Record<'uSelected' | 'uHovered' | 'uFocus', THREE.IUniform<number>>;

// Shared by the solid nodes and their halos so dimmed nodes don't keep glowing.
export const nodeEmphasisShader = `
  attribute float nodeIndex;
  uniform float uSelected;
  uniform float uHovered;
  uniform float uFocus;
  varying float vNodeEmphasis;
  float nodeEmphasis() {
    if (abs(nodeIndex - uSelected) < .5) return 1.12;
    if (abs(nodeIndex - uHovered) < .5) return 1.2;
    return mix(1.0, .12, uFocus);
  }
`;

export function nodeColor(node: { color: string; session: { id: string } }) {
  const color = new THREE.Color(node.color);
  const hsl = color.getHSL({ h: 0, s: 0, l: 0 }, THREE.SRGBColorSpace);
  const id = node.session.id;
  // Stable variations within the directory's color family, even after filtering.
  return color.setHSL(
    hsl.h + (hash(`${id}:hue`) - .5) * .09,
    THREE.MathUtils.clamp(hsl.s + hash(`${id}:saturation`) * .12, .4, .72),
    .63 + hash(`${id}:lightness`) * .11,
    THREE.SRGBColorSpace,
  );
}

export function createNodeMaterial(uniforms: FocusUniforms) {
  const material = new THREE.MeshBasicMaterial();
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = `${nodeEmphasisShader}
      varying vec3 vSphereNormal; varying vec3 vSphereView;
      ${shader.vertexShader}`.replace('#include <project_vertex>', `
        #include <project_vertex>
        // Instances only translate/uniformly scale. Keep the original sphere
        // normals when the graph's depth is flattened, retaining depth cues in 2D.
        vSphereNormal = mat3(viewMatrix) * normal;
        vSphereView = -mvPosition.xyz;
        vNodeEmphasis = nodeEmphasis();
      `);
    shader.fragmentShader = `varying vec3 vSphereNormal; varying vec3 vSphereView; varying float vNodeEmphasis;
      ${shader.fragmentShader}`.replace('#include <color_fragment>', `
        #include <color_fragment>
        vec3 n = normalize(vSphereNormal);
        float facing = max(dot(n, normalize(vSphereView)), 0.0);
        float light = .8 + .4 * max(dot(n, normalize(vec3(-.5, .65, 1.0))), 0.0);
        // Luminous colored centers bloom; a soft rim still separates overlaps.
        float rim = mix(.35, 1.0, smoothstep(0.0, .28, facing));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), .07 * facing);
        diffuseColor.rgb *= 1.4 * light * rim * vNodeEmphasis;
      `);
  };
  return material;
}
