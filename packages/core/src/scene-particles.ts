import * as THREE from 'three';
import { hash, progressX, timeX } from './layout';
import { nodeColor } from './node-appearance';
import { crossedMessages, PARTICLE_BUDGETS, particleSample, scrubImpulse } from './particle-motion';
import { SPIRAL_BASE, SPIRAL_RAMP, SPIRAL_RATE, SPIRAL_WIDTH, spiralPosition } from './spiral';
import { isConversationMessage, type TimelineSummary } from './timeline';
import { DEFAULT_PREFERENCES, type Preferences } from './preferences';
import type { Graph, GraphNode } from './types';

const TAU = Math.PI * 2;
const pointFragment = `
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - .5) * 2.;
    if (d > 1. || vAlpha < .001) discard;
    gl_FragColor = vec4(vColor, (exp(-d*d*5.) + .25*exp(-d*d*35.)) * (1.-smoothstep(.7,1.,d)) * vAlpha);
  }`;
const material = (uniforms: Record<string, THREE.IUniform>, vertexShader: string, fragmentShader = pointFragment) => new THREE.ShaderMaterial({
  uniforms, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const attribute = (values: number[] | Float32Array, size: number) => new THREE.Float32BufferAttribute(values, size);

/** Cosmetic layers only: never change graph nodes, marker positions, or picking geometry. */
export class SceneParticles {
  readonly group = new THREE.Group();
  private graph: Graph = { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
  private preferences = { ...DEFAULT_PREFERENCES };
  private selected?: GraphNode;
  private indices = new Map<string, number>();
  private kinds = new Map<string, number>();
  private dust?: THREE.Points;
  private energy?: THREE.Points;
  private energyIndices: number[] = [];
  private energyReveal?: THREE.BufferAttribute;
  private windBand?: THREE.Mesh;
  private orbit?: THREE.Group;
  private sparkGeometry?: THREE.BufferGeometry;
  private burstCursor = 0;
  private packets: { x: number; born: number }[] = [];
  private messageXs: number[] = [];
  private packetGeometry?: THREE.BufferGeometry;
  private time = 0;
  private wind = 0;
  private lastScrub = -Infinity;
  private pointerActive = false;
  private pointerAt = -Infinity;
  private visibleBirthsUntil = 0;
  private uniforms = {
    uTime: { value: 0 }, uPixelScale: { value: 1000 }, uPixelRatio: { value: 1 }, uHeadX: { value: 150 },
    uViewport: { value: new THREE.Vector2(1000, 600) },
    uPointer: { value: new THREE.Vector2(3, 3) }, uPointerVelocity: { value: new THREE.Vector2() }, uPointerStrength: { value: 0 },
    uHover: { value: new THREE.Vector3() }, uHoverStrength: { value: 0 },
    uWind: { value: 0 }, uWindX: { value: 0 }, uTimeAxis: { value: new THREE.Vector2(1, 0) },
    uFlow: { value: 0 }, uSpeed: { value: .5 }, uOpacity: { value: 1 },
    uSelectedIndex: { value: -1 }, uSelectedOnly: { value: 0 }, uFocus: { value: 0 },
    uOrbitCenter: { value: new THREE.Vector3() }, uOrbitRadius: { value: 1 }, uOrbitColor: { value: new THREE.Color() },
    uOrbitBorn: { value: 0 },
  };

  configure(preferences: Preferences) {
    const qualityChanged = preferences.quality !== this.preferences.quality;
    this.preferences = { ...preferences };
    if (qualityChanged && this.graph.nodes.length) {
      const messages = this.messageXs;
      this.setGraph(this.graph); this.messageXs = messages;
    }
    this.uniforms.uSpeed.value = preferences.trailSpeed / 100;
    this.uniforms.uOpacity.value = preferences.trailOpacity / 100;
    this.uniforms.uSelectedOnly.value = Number(preferences.trails === 'selected');
    if (!preferences.messageDots) this.packets = [];
  }

  setGraph(graph: Graph) {
    this.disposeLayers();
    this.graph = graph;
    this.indices = new Map(graph.nodes.map((node, index) => [node.session.id, index]));
    this.kinds = new Map(graph.edges.map(edge => [edge.to, edge.kind === 'fork' ? 1 : 2]));
    this.burstCursor = 0; this.visibleBirthsUntil = 0; this.wind = 0; this.lastScrub = -Infinity;
    this.packets = []; this.messageXs = [];
    this.energyIndices = []; this.energyReveal = undefined;
    if (!graph.nodes.length) { this.select(); return; }
    const budget = PARTICLE_BUDGETS[this.preferences.quality];
    const bounds = new THREE.Box3();
    for (const node of graph.nodes) { bounds.expandByPoint(new THREE.Vector3(...node.position)); bounds.expandByPoint(new THREE.Vector3(...node.startPosition)); }
    bounds.expandByVector(new THREE.Vector3(18, 18, 24));
    const size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
    const positions: number[] = [], seeds: number[] = [], colors: number[] = [];
    for (let index = 0; index < budget.dust; index++) {
      // Mostly lane-adjacent dust, with some room between lanes.
      const node = graph.nodes[Math.floor(hash(`dust-lane${index}`) * (graph.nodes.length - 1))];
      positions.push(bounds.min.x + hash(`dust-x${index}`) * size.x,
        index % 4 ? node.position[1] + (hash(`dust-y${index}`) - .5) * 34 : bounds.min.y + hash(`dust-y${index}`) * size.y,
        node.position[2] + (hash(`dust-z${index}`) - .5) * 65);
      seeds.push(hash(`dust-seed${index}`));
      colors.push(...new THREE.Color(node.color).toArray());
    }
    const dustGeometry = new THREE.BufferGeometry();
    dustGeometry.setAttribute('position', attribute(positions, 3)); dustGeometry.setAttribute('seed', attribute(seeds, 1)); dustGeometry.setAttribute('tint', attribute(colors, 3));
    this.dust = new THREE.Points(dustGeometry, material(this.uniforms, `
      attribute float seed; attribute vec3 tint;
      uniform float uTime,uPixelRatio,uPointerStrength,uHoverStrength,uWind,uWindX;
      uniform vec2 uViewport,uPointer,uPointerVelocity,uTimeAxis; uniform vec3 uHover;
      varying vec3 vColor; varying float vAlpha,vStretch; varying vec2 vAxis;
      void main() {
        vec3 p=position+vec3(sin(uTime*.14+seed*31.)*1.4,cos(uTime*.19+seed*19.)*1.6,sin(uTime*.12+seed*23.)*1.8);
        float gust=exp(-abs(p.x-uWindX)/22.)*abs(uWind);
        p.x+=uWind*gust*14.;
        vec4 mv=modelViewMatrix*vec4(p,1.); vec4 clip=projectionMatrix*mv;
        vec2 screen=clip.xy/max(.001,clip.w);
        vec2 delta=(screen-uPointer)*uViewport*.5;
        float influence=exp(-dot(delta,delta)/9000.)*uPointerStrength;
        vec2 tangent=vec2(-delta.y,delta.x)/max(1.,length(delta));
        clip.xy+=(tangent*influence*10.+uPointerVelocity*influence*26.)*2./uViewport*clip.w;
        vec4 hover=projectionMatrix*modelViewMatrix*vec4(uHover,1.);
        vec2 target=hover.xy/max(.001,hover.w);
        vec2 hd=(screen-target)*uViewport*.5;
        float attraction=exp(-dot(hd,hd)/7000.)*uHoverStrength;
        float angle=uTime*(.5+seed*.5)+seed*62.;
        vec2 orbit=target+vec2(cos(angle),sin(angle))*(17.+seed*22.)*2./uViewport;
        clip.xy=mix(clip.xy,orbit*clip.w,attraction*.72);
        gl_Position=clip;
        vStretch=1.+gust*5.+influence*min(3.,length(uPointerVelocity)*2.);
        vAxis=gust>.01?uTimeAxis:(length(uPointerVelocity)>.001?normalize(uPointerVelocity):vec2(1.,0.));
        gl_PointSize=(1.3+seed*1.7)*uPixelRatio*vStretch;
        vColor=mix(tint,vec3(.75,.91,1.),.4);
        vAlpha=(.14+seed*.22)*(.72+.28*sin(uTime*.7+seed*62.))+gust*.2+attraction*.2;
      }`, `
      varying vec3 vColor; varying float vAlpha,vStretch; varying vec2 vAxis;
      void main() {
        vec2 p=(gl_PointCoord-.5)*2.;
        vec2 q=vec2(dot(p,vAxis),dot(p,vec2(-vAxis.y,vAxis.x))*vStretch);
        float d=length(q); if(d>1.) discard;
        gl_FragColor=vec4(vColor,exp(-d*d*4.)*(1.-smoothstep(.65,1.,d))*vAlpha);
      }`));
    this.dust.name = 'interactive-stardust'; this.dust.frustumCulled = false; this.group.add(this.dust);

    this.windBand = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material({
      ...this.uniforms, uBandCenter: { value: center }, uBandHeight: { value: size.y },
    }, `
      uniform float uWindX,uBandHeight; uniform vec3 uBandCenter; varying vec2 vUv;
      void main(){vUv=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(uWindX+position.x*8.,uBandCenter.y+position.y*uBandHeight,uBandCenter.z,1.);}
    `, `
      uniform float uWind; varying vec2 vUv;
      void main(){float a=exp(-abs(vUv.x-.5)*15.)*pow(max(0.,sin(vUv.y*3.14159)),.6)*abs(uWind)*.16;
        gl_FragColor=vec4(.55,.86,1.,a);}
    `));
    this.windBand.name = 'scrub-time-wind'; (this.windBand.material as THREE.ShaderMaterial).side = THREE.DoubleSide; this.windBand.frustumCulled = false; this.group.add(this.windBand);
    this.createEnergy(budget.trails);
    this.createBursts(budget.bursts, budget.sparks);
    this.createPackets();
    this.createOrbit();
    this.select(this.selected && graph.nodes.find(node => node.session.id === this.selected!.session.id));
  }

  private createEnergy(limit: number) {
    const nodes = particleSample(this.graph.nodes.filter(node => node.position[0] > node.startPosition[0]), limit);
    const origins: number[] = [], ends: number[] = [], radii: number[] = [], seeds: number[] = [], colors: number[] = [], points: number[] = [], indices: number[] = [];
    for (const node of nodes) for (let tail = 0; tail < 6; tail++) {
      origins.push(...node.startPosition); ends.push(node.position[0]); radii.push(node.radius); seeds.push(hash(node.session.id));
      colors.push(...nodeColor(node).toArray()); points.push(tail, 0, 0); indices.push(this.indices.get(node.session.id)!);
    }
    const geometry = new THREE.BufferGeometry();
    for (const [name, values, size] of [['position', points, 3], ['origin', origins, 3], ['endX', ends, 1], ['radius', radii, 1], ['seed', seeds, 1], ['tint', colors, 3], ['nodeIndex', indices, 1]] as const) geometry.setAttribute(name, attribute(values, size));
    this.energyIndices = indices;
    this.energyReveal = attribute(new Float32Array(indices.length), 1); geometry.setAttribute('reveal', this.energyReveal);
    this.energy = new THREE.Points(geometry, material(this.uniforms, `
      attribute vec3 origin,tint; attribute float endX,radius,seed,reveal,nodeIndex;
      uniform float uTime,uHeadX,uPixelScale,uFlow,uSpeed,uOpacity,uSelectedIndex,uSelectedOnly,uFocus;
      varying vec3 vColor; varying float vAlpha;
      void main(){
        float head=clamp(uHeadX,origin.x,endX),span=max(0.,head-origin.x);
        float t=fract(uTime*(.12+uSpeed*.23)+seed)-position.x*.014;
        float distance=max(0.,t)*span;
        float angle=distance*${SPIRAL_RATE}+seed*${TAU};
        float curl=(${SPIRAL_BASE}+radius*${SPIRAL_WIDTH})*smoothstep(0.,${SPIRAL_RAMP.toFixed(1)},distance);
        vec3 p=vec3(origin.x+distance,origin.y+cos(angle)*curl,origin.z+sin(angle)*curl);
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        float selected=1.-step(.5,abs(nodeIndex-uSelectedIndex));
        float allowed=mix(1.,selected,uSelectedOnly)*mix(1.,mix(.1,1.,selected),uFocus);
        gl_PointSize=clamp((.1+radius*.12)*uPixelScale/max(.1,-mv.z),1.5,5.5)*(1.-position.x*.09);
        vColor=mix(tint,vec3(1.),.42)*(1.35-position.x*.09);
        vAlpha=step(.01,span)*step(0.,t)*smoothstep(0.,.08,t)*smoothstep(0.,.05,1.-t)*exp(-position.x*.55)*reveal*uFlow*uOpacity*allowed;
      }`));
    this.energy.name = 'trail-energy-packets'; this.energy.frustumCulled = false; this.group.add(this.energy);
  }

  private createBursts(count: number, sparks: number) {
    const sparkGeometry = new THREE.BufferGeometry();
    for (const [name, size] of [['position', 3], ['origin', 3], ['tint', 3], ['born', 1], ['kind', 1]] as const) {
      const values = new Float32Array(count * sparks * size); if (name === 'born') values.fill(-1000);
      sparkGeometry.setAttribute(name, attribute(values, size).setUsage(THREE.DynamicDrawUsage));
    }
    for (let index = 0; index < count * sparks; index++) {
      const angle = hash(`birth-angle${index}`) * TAU, z = hash(`birth-depth${index}`) * 2 - 1;
      sparkGeometry.getAttribute('position').setXYZ(index, Math.cos(angle) * Math.sqrt(1 - z*z), Math.sin(angle) * Math.sqrt(1 - z*z), z);
    }
    this.sparkGeometry = sparkGeometry;
    const points = new THREE.Points(sparkGeometry, material(this.uniforms, `
      attribute vec3 origin,tint;attribute float born,kind;
      uniform float uTime,uPixelScale,uHeadX;varying vec3 vColor;varying float vAlpha;
      void main(){
        float age=uTime-born;vec3 direction=position;
        if(age<0. || age>1.2 || origin.x>uHeadX){vAlpha=0.;vColor=tint;gl_PointSize=1.;gl_Position=vec4(2.,2.,2.,1.);return;}
        if(kind>.5 && kind<1.5)direction=vec3(abs(position.x)*.8+.35,sign(position.y)*(.6+abs(position.y)),position.z*.35);
        float distance=(1.-exp(-max(0.,age)*3.))*(2.2+kind*1.7);
        vec3 p=origin+direction*distance;p.y-=max(0.,age)*max(0.,age)*.5;
        vec4 mv=modelViewMatrix*vec4(p,1.);gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp(.15*uPixelScale/max(.1,-mv.z),1.5,5.);
        vColor=mix(tint,vec3(1.),.38)*1.35;
        vAlpha=step(0.,age)*pow(max(0.,1.-age/1.2),2.)*.8;
      }`));
    points.name = 'fork-bloom-sparks'; points.frustumCulled = false; this.group.add(points);
  }

  births(nodes: readonly GraphNode[], time: number) {
    if (!this.sparkGeometry || !nodes.length) return;
    const geometry = this.sparkGeometry;
    const budget = PARTICLE_BUDGETS[this.preferences.quality];
    // Reserve half the batch for branching; spread a dense import's flashes around the map.
    const branches = particleSample(nodes.filter(node => this.kinds.has(node.session.id)), Math.ceil(budget.bursts / 2));
    const chosen = [...branches, ...particleSample(nodes.filter(node => !this.kinds.has(node.session.id)), budget.bursts - branches.length)];
    for (const node of chosen) {
      const slot = this.burstCursor++ % budget.bursts, kind = this.kinds.get(node.session.id) || 0;
      const color = nodeColor(node).lerp(new THREE.Color(kind === 1 ? '#ffc891' : '#c3b0ff'), kind ? .35 : 0);
      const origin = spiralPosition(node, Math.max(node.startPosition[0], Math.min(this.uniforms.uHeadX.value, node.position[0])));
      const start = slot * budget.sparks;
      for (let index = start; index < start + budget.sparks; index++) {
        geometry.getAttribute('origin').setXYZ(index, ...origin);
        geometry.getAttribute('tint').setXYZ(index, color.r, color.g, color.b);
        geometry.getAttribute('born').setX(index, time); geometry.getAttribute('kind').setX(index, kind);
      }
    }
    for (const name of ['origin', 'tint', 'born', 'kind']) geometry.getAttribute(name).needsUpdate = true;
    this.visibleBirthsUntil = time + 1.2;
  }

  private createPackets() {
    this.packetGeometry = new THREE.BufferGeometry();
    this.packetGeometry.setAttribute('position', attribute(new Float32Array(8 * 8 * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.packetGeometry.setAttribute('alpha', attribute(new Float32Array(8 * 8), 1).setUsage(THREE.DynamicDrawUsage));
    this.packetGeometry.setDrawRange(0, 0);
    const points = new THREE.Points(this.packetGeometry, material(this.uniforms, `
      attribute float alpha;uniform float uPixelScale;uniform vec3 uOrbitColor;varying vec3 vColor;varying float vAlpha;
      void main(){vec4 mv=modelViewMatrix*vec4(position,1.);gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp(.2*uPixelScale/max(.1,-mv.z),2.,7.);vColor=mix(uOrbitColor,vec3(1.),.6)*1.6;vAlpha=alpha;}
    `));
    points.name = 'recorded-message-packets'; points.frustumCulled = false; this.group.add(points);
  }

  private createOrbit() {
    this.orbit = new THREE.Group(); this.orbit.name = 'selection-solar-system';
    const shared = `
      uniform float uTime,uPixelScale,uPixelRatio,uOrbitRadius,uOrbitBorn;
      uniform vec3 uOrbitCenter,uOrbitColor;
      varying vec3 vColor;varying float vAlpha;
      vec2 orbit(float angle,float ring){
        vec2 p=vec2(cos(angle),sin(angle)*mix(.5,.7,ring))*(1.+ring*.26);
        float tilt=mix(.45,-.65,ring)+uTime*.06;
        return mat2(cos(tilt),sin(tilt),-sin(tilt),cos(tilt))*p;
      }
      float orbitSize(vec4 mv){return max(uOrbitRadius,-mv.z/uPixelScale*uPixelRatio*14.);}
    `;
    for (let ring = 0; ring < 2; ring++) {
      const mesh = new THREE.Mesh(new THREE.RingGeometry(.985, 1., 96), material(this.uniforms, `${shared}
        void main(){
          vec4 mv=modelViewMatrix*vec4(uOrbitCenter,1.);
          float angle=atan(position.y,position.x);
          mv.xy+=orbit(angle,${ring.toFixed(1)})*length(position.xy)*orbitSize(mv);
          gl_Position=projectionMatrix*mv;
          vColor=uOrbitColor;vAlpha=.24*smoothstep(0.,.4,uTime-uOrbitBorn);
        }`, `varying vec3 vColor;varying float vAlpha;void main(){gl_FragColor=vec4(vColor,vAlpha);}`));
      mesh.material.side = THREE.DoubleSide; mesh.frustumCulled = false; this.orbit.add(mesh);
    }
    const geometry = new THREE.BufferGeometry(), positions: number[] = [];
    for (let satellite = 0; satellite < 6; satellite++) for (let tail = 0; tail < 5; tail++) positions.push(satellite / 3 * TAU, satellite % 2, tail);
    geometry.setAttribute('position', attribute(positions, 3));
    const points = new THREE.Points(geometry, material(this.uniforms, `${shared}
      void main(){
        float angle=position.x+uTime*mix(.8,-.6,position.y)-position.z*.07*mix(1.,-1.,position.y);
        vec4 mv=modelViewMatrix*vec4(uOrbitCenter,1.);
        mv.xy+=orbit(angle,position.y)*orbitSize(mv);gl_Position=projectionMatrix*mv;
        gl_PointSize=(3.5-position.z*.45)*uPixelRatio;
        vColor=mix(uOrbitColor,vec3(1.),.5);vAlpha=exp(-position.z*.6)*smoothstep(0.,.4,uTime-uOrbitBorn);
      }`));
    points.frustumCulled = false; this.orbit.add(points); this.group.add(this.orbit);
  }

  select(node?: GraphNode) {
    this.selected = node; this.messageXs = []; this.packets = [];
    this.uniforms.uSelectedIndex.value = node ? this.indices.get(node.session.id) ?? -1 : -1;
    this.uniforms.uOrbitBorn.value = this.time;
    if (node) this.uniforms.uOrbitColor.value.copy(nodeColor(node));
  }

  events(items: readonly TimelineSummary[]) {
    this.messageXs = this.selected ? items.filter(item => isConversationMessage(item) && item.time !== null && item.timeSource !== 'unknown')
      .map(item => timeX(item.time!, this.graph)).filter(x => x >= this.selected!.startPosition[0] && x <= this.selected!.position[0]).sort((a, b) => a - b) : [];
  }

  seek(from: number, to: number, playing: boolean, scrubbing: boolean) {
    this.uniforms.uHeadX.value = to;
    if (scrubbing) {
      this.wind = scrubImpulse(from, to, Number.isFinite(this.lastScrub) ? this.time - this.lastScrub : 1 / 30, Math.max(1, progressX(1, this.graph) - progressX(0, this.graph)));
      this.lastScrub = this.time;
      this.uniforms.uWindX.value = to;
    }
    if (to < from) this.packets = [];
    if (playing && this.preferences.messageDots && this.selected) {
      for (const x of crossedMessages(this.messageXs, from, to)) this.packets.push({ x, born: this.time });
      this.packets = this.packets.slice(-8);
    }
  }

  pointer(x: number, y: number, width: number, height: number) {
    const next = new THREE.Vector2(x / width * 2 - 1, 1 - y / height * 2);
    const velocity = next.clone().sub(this.uniforms.uPointer.value).multiplyScalar(12);
    if (!this.pointerActive) velocity.set(0, 0);
    velocity.clampLength(0, 1.5);
    this.uniforms.uPointerVelocity.value.copy(velocity);
    this.uniforms.uPointer.value.copy(next); this.pointerActive = true; this.pointerAt = this.time;
  }

  leave() { this.pointerActive = false; }

  update(time: number, delta: number, camera: THREE.Camera, reveals: Float32Array, options: {
    motion: boolean; suspended: boolean; playing: boolean; pixelScale: number; pixelRatio: number; width: number; height: number;
    selectedCenter?: readonly number[]; hoverCenter?: readonly number[];
  }) {
    this.time = time; this.group.visible = options.motion && !options.suspended && this.graph.nodes.length > 0;
    this.uniforms.uTime.value = time; this.uniforms.uPixelScale.value = options.pixelScale; this.uniforms.uPixelRatio.value = options.pixelRatio;
    this.uniforms.uViewport.value.set(options.width, options.height);
    this.uniforms.uPointerStrength.value = THREE.MathUtils.damp(this.uniforms.uPointerStrength.value, Number(this.pointerActive), 7, delta);
    if (time - this.pointerAt > .03) this.uniforms.uPointerVelocity.value.multiplyScalar(Math.exp(-delta * 6));
    this.uniforms.uHoverStrength.value = THREE.MathUtils.damp(this.uniforms.uHoverStrength.value, Number(!!options.hoverCenter), 8, delta);
    if (options.hoverCenter) this.uniforms.uHover.value.fromArray(options.hoverCenter);
    this.wind *= Math.exp(-delta * 4.5); this.uniforms.uWind.value = this.wind;
    const view = camera.matrixWorldInverse.elements;
    this.uniforms.uTimeAxis.value.set(view[0], view[1]); if (this.uniforms.uTimeAxis.value.lengthSq() < .0001) this.uniforms.uTimeAxis.value.set(1, 0); else this.uniforms.uTimeAxis.value.normalize();
    const flow = options.playing || this.preferences.trailFlow;
    this.uniforms.uFlow.value = Number(flow);
    this.uniforms.uFocus.value = Number(this.preferences.focusDimming && !!this.selected && !options.playing);
    if (this.dust) this.dust.visible = this.preferences.stars;
    if (this.windBand) this.windBand.visible = Math.abs(this.wind) > .005;
    if (this.energy) this.energy.visible = this.preferences.trails !== 'off' && flow;
    if (this.energyReveal) {
      let changed = false;
      this.energyIndices.forEach((index, particle) => { const value = reveals[index] || 0; if (this.energyReveal!.getX(particle) !== value) { this.energyReveal!.setX(particle, value); changed = true; } });
      if (changed) this.energyReveal.needsUpdate = true;
    }
    if (this.orbit) this.orbit.visible = !!options.selectedCenter;
    if (options.selectedCenter && this.selected) {
      this.uniforms.uOrbitCenter.value.fromArray(options.selectedCenter);
      this.uniforms.uOrbitRadius.value = this.selected.radius * this.preferences.nodeScale / 100 * 2.7;
    }
    this.packets = this.packets.filter(packet => time - packet.born < 1.15);
    let count = 0;
    if (this.packetGeometry && this.selected && this.preferences.messageDots && options.selectedCenter) {
      for (const packet of this.packets) for (let tail = 0; tail < 8; tail++) {
        const age = time - packet.born - tail * .018;
        const progress = Math.max(0, Math.min(1, age / .75));
        const head = Math.min(this.uniforms.uHeadX.value, this.selected.position[0]);
        const x = Math.max(this.selected.startPosition[0], Math.min(head, packet.x + (head - packet.x) * progress));
        this.packetGeometry.getAttribute('position').setXYZ(count, ...spiralPosition(this.selected, x));
        this.packetGeometry.getAttribute('alpha').setX(count++, age < 0 ? 0 : Math.exp(-tail * .35) * Math.max(0, 1 - age / 1.15));
      }
    }
    if (this.packetGeometry) {
      this.packetGeometry.setDrawRange(0, count);
      this.packetGeometry.getAttribute('position').needsUpdate = true; this.packetGeometry.getAttribute('alpha').needsUpdate = true;
    }
    return this.group.visible && (this.preferences.stars || (flow && this.preferences.trails !== 'off') || !!options.selectedCenter || Math.abs(this.wind) > .005 || time < this.visibleBirthsUntil || this.packets.length > 0);
  }

  reset() {
    this.packets = []; this.wind = 0; this.lastScrub = -Infinity; this.visibleBirthsUntil = 0; this.leave();
    const born = this.sparkGeometry?.getAttribute('born'); if (born) { (born.array as Float32Array).fill(-1000); born.needsUpdate = true; }
  }

  dispose() { this.disposeLayers(); this.energyIndices = []; this.packets = []; this.messageXs = []; }

  diagnostics() {
    return { enabled: this.group.visible, dust: this.dust?.geometry.getAttribute('position').count || 0,
      energyParticles: this.energyIndices.length, burstSlots: PARTICLE_BUDGETS[this.preferences.quality].bursts,
      messagePackets: this.packets.length, wind: this.wind, orbit: !!this.orbit?.visible };
  }

  private disposeLayers() {
    this.group.traverse(object => {
      const drawable = object as THREE.Mesh; drawable.geometry?.dispose();
      if (drawable.material) (Array.isArray(drawable.material) ? drawable.material : [drawable.material]).forEach(item => item.dispose());
    });
    this.group.clear();
    this.dust = undefined; this.energy = undefined; this.windBand = undefined; this.orbit = undefined;
    this.sparkGeometry = undefined; this.packetGeometry = undefined;
  }
}
