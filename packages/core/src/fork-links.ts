import * as THREE from 'three';

type Link = { curve: THREE.CubicBezierCurve3; color: THREE.Color; child: number };

/** Screen-width ribbons retain the relationship color, with a glowing travelling tip. */
export class ForkLinks {
  readonly group = new THREE.Group();
  private progress: THREE.InstancedBufferAttribute;

  constructor(private links: Link[], uniforms: Record<string, THREE.IUniform>, selected = false) {
    this.group.userData.kind = 'relationship';
    const strip = new THREE.PlaneGeometry(1, 2, 48, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.index = strip.index; geometry.attributes = strip.attributes; geometry.instanceCount = links.length;
    for (const [name, key] of [['a', 'v0'], ['b', 'v1'], ['c', 'v2'], ['d', 'v3']] as const) {
      geometry.setAttribute(name, new THREE.InstancedBufferAttribute(Float32Array.from(links.flatMap(link => link.curve[key].toArray())), 3));
    }
    geometry.setAttribute('color', new THREE.InstancedBufferAttribute(Float32Array.from(links.flatMap(link => link.color.toArray())), 3));
    this.progress = new THREE.InstancedBufferAttribute(new Float32Array(links.length), 1).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('reveal', this.progress);
    const ribbon = new THREE.Mesh(geometry, new THREE.ShaderMaterial({
      uniforms: { ...uniforms, uIntensity: { value: selected ? 1.15 : .65 } },
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 a,b,c,d; attribute float reveal; uniform float uPixelScale,uPixelRatio;
        varying vec3 vColor; varying float vAcross,vAlong,vReveal;
        vec3 curve(float t) { float s=1.-t; return s*s*s*a+3.*s*s*t*b+3.*s*t*t*c+t*t*t*d; }
        void main() {
          float t=uv.x*reveal; vec3 p=curve(t);
          vec2 axis=(modelViewMatrix*vec4(curve(min(1.,t+.001))-curve(max(0.,t-.001)),0.)).xy;
          vec2 normal=length(axis)>.0001?normalize(vec2(-axis.y,axis.x)):vec2(0.,1.);
          vec4 mv=modelViewMatrix*vec4(p,1.);
          mv.xy+=normal*position.y*max(.015,-mv.z/uPixelScale*5.5*uPixelRatio);
          gl_Position=projectionMatrix*mv; vColor=color; vAcross=position.y; vAlong=uv.x; vReveal=reveal;
        }`,
      fragmentShader: `uniform float uIntensity,uContextFocus; varying vec3 vColor; varying float vAcross,vAlong,vReveal;
        void main() {
          if(vReveal<=0.) discard;
          float core=exp(-vAcross*vAcross*100.), aura=exp(-vAcross*vAcross*4.)*(1.-smoothstep(.65,1.,abs(vAcross)));
          float distance=(1.-clamp(vAlong,0.,1.))*16.;
          float tip=exp(-distance*distance)*max(0.,sin(vReveal*3.14159));
          vec3 tint=mix(vColor,vec3(1.),tip*.18);
          float alpha=(core*.8+aura*.24+tip*aura*.7)*smoothstep(0.,.04,vReveal)*uIntensity*mix(1.,.16,uContextFocus);
          gl_FragColor=vec4(tint*(1.2+tip),alpha);
        }`,
    }));
    ribbon.frustumCulled = false; this.group.add(ribbon);
  }

  update(reveals: Float32Array) {
    this.links.forEach((link, index) => this.progress.setX(index, reveals[link.child]));
    this.progress.needsUpdate = true;
  }

  samples() { return Array.from(this.progress.array).slice(0, 32); }
}
