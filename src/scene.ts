import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { hash } from './layout';
import type { FileChange, Graph, GraphNode } from './types';

type Label = { element: HTMLDivElement; point: THREE.Vector3; priority?: boolean };

function clearGroup(group: THREE.Group) {
  group.traverse((object) => {
    const drawable = object as THREE.Mesh;
    if (object instanceof THREE.InstancedMesh) object.dispose();
    drawable.geometry?.dispose();
    if (drawable.material) {
      const materials = Array.isArray(drawable.material) ? drawable.material : [drawable.material];
      materials.forEach((material) => material.dispose());
    }
  });
  group.clear();
}

export class TimelineScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2500);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private smaa: SMAAPass;
  private dirty = true;
  private graphGroup = new THREE.Group();
  private selectionGroup = new THREE.Group();
  private filesGroup = new THREE.Group();
  private labels: Label[] = [];
  private labelLayer: HTMLDivElement;
  private graph: Graph = { nodes: [], edges: [], lanes: [], start: 0, end: 0 };
  private nodeMesh?: THREE.InstancedMesh;
  private nodeByID = new Map<string, GraphNode>();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private pointerDown = new THREE.Vector2();
  private selected: string | null = null;
  private hovered: string | null = null;
  private cutoff = 1;
  private clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 151);
  private flat = false;
  private motion = !matchMedia('(prefers-reduced-motion: reduce)').matches;
  private suspended = false;
  private frame = 0;
  private resizeObserver: ResizeObserver;
  private targetPosition?: THREE.Vector3;
  private targetLook?: THREE.Vector3;
  private playing = false;
  private playbackPath?: THREE.CatmullRomCurve3;
  private playbackRadii: number[] = [];
  private playbackSphere = new THREE.Spherical();
  private playbackFocus = new THREE.Vector3();
  private playbackOffset = new THREE.Vector3();
  private glowMaterial?: THREE.ShaderMaterial;
  private time = 0;
  private previousFrame = performance.now();
  private nodeReveal = new Float32Array();
  private revealAttribute?: THREE.BufferAttribute;
  private revealsActive = false;
  private graphBorn = 0;
  private fileMesh?: THREE.InstancedMesh;
  private fileOffsets: THREE.Vector3[] = [];
  private fileOrigin = new THREE.Vector3();
  private fileBorn = 0;
  private fileUniforms = { uTime: { value: 0 }, uBorn: { value: 0 }, uMotion: { value: 1 }, uOrigin: { value: new THREE.Vector3() } };
  private lineUniforms = { uCutoff: { value: 160 }, uReveal: { value: 1 } };
  private transform = new THREE.Object3D();
  private onSelect: (id: string) => void;
  private onHover: (node: GraphNode | null, x: number, y: number) => void;

  constructor(private container: HTMLElement, callbacks: {
    onSelect: (id: string) => void;
    onHover: (node: GraphNode | null, x: number, y: number) => void;
    onPlaybackInterrupt: () => void;
  }) {
    this.onSelect = callbacks.onSelect;
    this.onHover = callbacks.onHover;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    // Supersample thin filaments on 1x displays; cap retina rendering at 2x.
    this.renderer.setPixelRatio(Math.min(Math.max(devicePixelRatio, 1.5), 2));
    this.renderer.localClippingEnabled = true;
    // Linear background stays below bloom and matches the dark surrounding UI.
    this.renderer.setClearColor(new THREE.Color().setRGB(0.001, 0.0017, 0.0024), 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.domElement.setAttribute('aria-label', 'Interactive 3D session timeline. Drag to orbit, scroll to zoom. Sessions are also available in the list.');
    this.renderer.domElement.tabIndex = 0;
    container.append(this.renderer.domElement);
    this.labelLayer = document.createElement('div');
    this.labelLayer.className = 'scene-labels';
    this.labelLayer.dataset.motion = String(this.motion);
    container.append(this.labelLayer);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.rotateSpeed = 0.5;
    this.controls.zoomSpeed = 0.8;
    this.controls.minDistance = 15;
    this.controls.maxDistance = 1200;
    this.controls.addEventListener('start', () => {
      this.targetPosition = undefined; this.targetLook = undefined;
      if (this.playing) callbacks.onPlaybackInterrupt();
    });
    this.camera.position.set(20, 70, 320);
    this.scene.add(this.graphGroup, this.selectionGroup, this.filesGroup);
    // Canvas antialiasing does not reach EffectComposer's offscreen targets.
    // Resolve 4x MSAA before bloom. Three's SMAA operates in linear color,
    // so apply it before the final output transform.
    const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: Math.min(4, this.renderer.capabilities.maxSamples),
    });
    this.composer = new EffectComposer(this.renderer, renderTarget);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.23, 0.4, 0.9);
    this.composer.addPass(this.bloom);
    this.smaa = new SMAAPass();
    this.composer.addPass(this.smaa);
    this.composer.addPass(new OutputPass());
    // SMAA lookup images are embedded in the module and decode asynchronously.
    // r180 renamed these fields before the corresponding typings were updated.
    const lookups = this.smaa as SMAAPass & { _areaTexture?: THREE.Texture; _searchTexture?: THREE.Texture };
    for (const texture of [lookups._areaTexture ?? lookups.areaTexture, lookups._searchTexture ?? lookups.searchTexture]) {
      texture?.image?.addEventListener('load', () => { this.dirty = true; }, { once: true });
    }
    this.addStars();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.renderer.domElement.addEventListener('pointermove', this.pointerMove);
    this.renderer.domElement.addEventListener('pointerdown', this.pointerStart);
    this.renderer.domElement.addEventListener('pointerup', this.pointerEnd);
    this.renderer.domElement.addEventListener('pointerleave', this.pointerLeave);
    this.renderer.domElement.addEventListener('dblclick', this.doubleClick);
    this.renderer.domElement.addEventListener('webglcontextlost', this.contextLost);
    this.resize();
    this.animate();
  }

  private contextLost = (event: Event) => {
    event.preventDefault();
    this.container.dispatchEvent(new CustomEvent('scene-error', { detail: 'The graphics context was lost. Reload to restore the 3D view; the session list is still available.' }));
  };

  private addStars() {
    const positions: number[] = [];
    for (let i = 0; i < 280; i++) positions.push((hash(`sx${i}`) - 0.5) * 1100, (hash(`sy${i}`) - 0.5) * 700, -120 - hash(`sz${i}`) * 500);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    this.scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#7b9fa9', size: 0.4, transparent: true, opacity: 0.18, sizeAttenuation: true })));
  }

  setGraph(graph: Graph, fit = false) {
    this.dirty = true;
    clearGroup(this.graphGroup);
    clearGroup(this.selectionGroup);
    clearGroup(this.filesGroup);
    this.fileMesh = undefined;
    this.fileOffsets = [];
    this.labels = [];
    this.labelLayer.replaceChildren();
    this.graph = graph;
    this.buildPlaybackPath();
    this.nodeByID = new Map(graph.nodes.map((node) => [node.session.id, node]));
    this.nodeMesh = undefined;
    this.glowMaterial = undefined;
    this.graphBorn = this.time;
    this.nodeReveal = new Float32Array(graph.nodes.length).fill(this.motion ? 0 : 1);
    this.revealsActive = this.motion && graph.nodes.length > 0;
    if (!graph.nodes.length) return;
    const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial(), graph.nodes.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const transform = new THREE.Object3D();
    const color = new THREE.Color();
    const glowPositions: number[] = [], glowColors: number[] = [], glowSizes: number[] = [];
    graph.nodes.forEach((node, index) => {
      transform.position.fromArray(node.position);
      transform.scale.setScalar(node.radius);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      color.set(node.color).multiplyScalar(1.15);
      mesh.setColorAt(index, color);
      glowPositions.push(...node.position);
      glowColors.push(...new THREE.Color(node.color).toArray());
      glowSizes.push(node.radius * 9);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.nodeMesh = mesh;
    this.graphGroup.add(mesh);
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
    glowGeometry.setAttribute('color', new THREE.Float32BufferAttribute(glowColors, 3));
    glowGeometry.setAttribute('size', new THREE.Float32BufferAttribute(glowSizes, 1));
    this.revealAttribute = new THREE.BufferAttribute(this.nodeReveal, 1).setUsage(THREE.DynamicDrawUsage);
    glowGeometry.setAttribute('reveal', this.revealAttribute);
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: { uCutoff: { value: 151 }, uScale: { value: this.container.clientHeight * this.renderer.getPixelRatio() * 0.9 } },
      vertexShader: `attribute float size; attribute float reveal; varying vec3 vColor; varying float vVisible; uniform float uScale; uniform float uCutoff;
        void main() { vColor = color; vVisible = reveal; vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * (1.0 + sin(reveal * 3.14159) * .45) * uScale / -mv.z, 2.0, 100.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vColor; varying float vVisible;
        void main() { float d = length(gl_PointCoord - .5) * 2.0; if (d > 1.0) discard;
        float a = pow(1.0 - d, 3.5) * .3 * vVisible; gl_FragColor = vec4(vColor, a); }`,
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.graphGroup.add(new THREE.Points(glowGeometry, this.glowMaterial));

    // Faint filaments encode directory chronology, not parent-child relationships.
    const lanePositions: number[] = [], laneColors: number[] = [];
    graph.lanes.forEach((lane, index) => {
      const firstX = lane.nodes[0].position[0];
      const lastX = lane.nodes.at(-1)!.position[0];
      const span = Math.max(4, lastX - firstX);
      for (let strand = 0; lane.nodes.length > 1 && strand < 5; strand++) {
        const points: THREE.Vector3[] = [];
        for (let step = 0; step <= 65; step++) {
          const x = firstX - 3 + (span + 6) * step / 65;
          const wave = Math.sin((x + 150) / 65 + index * 0.7) * 3.5;
          const twist = Math.sin(step * 0.12 + strand * 1.8) * 1.1;
          points.push(new THREE.Vector3(x, lane.y + wave + twist * strand * .28, lane.z + Math.cos(step * .16 + strand) * strand * .3));
        }
        this.appendSegments(points, new THREE.Color(lane.color), lanePositions, laneColors);
      }
      if (index < 12) this.addLabel(lane.label, new THREE.Vector3(firstX - 4, lane.y + 8, lane.z), lane.color);
    });
    this.addLines(lanePositions, laneColors, 0.25);

    const edgePositions: number[] = [], edgeColors: number[] = [];
    for (const edge of graph.edges) {
      const from = this.nodeByID.get(edge.from)!;
      const to = this.nodeByID.get(edge.to)!;
      const curve = this.edgeCurve(from.position, to.position);
      this.appendSegments(curve.getPoints(22), new THREE.Color(edge.kind === 'fork' ? '#edbc8d' : '#bda6ef'), edgePositions, edgeColors);
    }
    this.addLines(edgePositions, edgeColors, 0.7);

    // Time reference marks sit below the main trunk, with real linear spacing.
    const gridPositions: number[] = [], gridColors: number[] = [];
    for (let tick = 0; tick <= 8; tick++) {
      const x = -150 + tick * 37.5;
      this.appendSegments([new THREE.Vector3(x, -105, -70), new THREE.Vector3(x, -105, 70)], new THREE.Color('#314149'), gridPositions, gridColors);
    }
    this.addLines(gridPositions, gridColors, 0.23);
    this.setCutoff(this.cutoff);
    if (this.selected) this.select(this.selected);
    if (fit) this.reset();
  }

  private appendSegments(points: THREE.Vector3[], color: THREE.Color, positions: number[], colors: number[]) {
    for (let i = 1; i < points.length; i++) {
      positions.push(...points[i - 1].toArray(), ...points[i].toArray());
      colors.push(color.r, color.g, color.b, color.r, color.g, color.b);
    }
  }

  private buildPlaybackPath() {
    this.playbackPath = undefined;
    this.playbackRadii = [];
    if (!this.graph.nodes.length) return;
    const points = this.graph.nodes.map((node) => new THREE.Vector3(...node.position));
    const overview = new THREE.Box3().setFromPoints(points).getBoundingSphere(new THREE.Sphere());
    const centers: THREE.Vector3[] = [];
    // Sample the activity frontier once per graph. Recency-weighted framing
    // follows spawning clusters, with a small look-ahead to prepare for branches.
    // The spline and per-frame damping prevent individual nodes jerking the view.
    for (let step = 0; step <= 100; step++) {
      const progress = step / 100, frontier = progress * 300 - 150;
      const center = new THREE.Vector3(), bounds = new THREE.Box3();
      let total = 0;
      for (const point of points) {
        const distance = point.x - frontier;
        const weight = Math.exp(-(((distance + 6) / 24) ** 2));
        center.addScaledVector(point, weight); total += weight;
        if (distance >= -38 && distance <= 12) bounds.expandByPoint(point);
      }
      center.divideScalar(total);
      const cluster = bounds.isEmpty() ? new THREE.Sphere(center, 0) : bounds.getBoundingSphere(new THREE.Sphere());
      const radius = Math.max(65, cluster.radius + cluster.center.distanceTo(center));
      // Pull back gently for the closing wide shot as the last nodes arrive.
      const outro = THREE.MathUtils.smoothstep(progress, .86, 1);
      center.lerp(overview.center, outro * .65);
      centers.push(center);
      this.playbackRadii.push(THREE.MathUtils.lerp(radius, overview.radius + 20, outro));
    }
    this.playbackPath = new THREE.CatmullRomCurve3(centers);
  }

  setPlaying(playing: boolean) {
    if (this.playing === playing) return;
    this.playing = playing;
    if (playing && this.motion) {
      this.targetPosition = undefined; this.targetLook = undefined;
      this.playbackSphere.setFromVector3(this.camera.position.clone().sub(this.controls.target));
    }
    this.dirty = true;
  }

  private animatePlaybackCamera(delta: number) {
    if (!this.playing || !this.motion || !this.playbackPath) return false;
    this.playbackPath.getPoint(this.cutoff, this.playbackFocus);
    if (this.flat) this.playbackFocus.z = 0;
    const sample = this.cutoff * (this.playbackRadii.length - 1);
    const first = Math.floor(sample), last = Math.min(first + 1, this.playbackRadii.length - 1);
    const radius = THREE.MathUtils.lerp(this.playbackRadii[first], this.playbackRadii[last], sample - first);
    const verticalFov = THREE.MathUtils.degToRad(this.camera.fov) / 2;
    const framingFov = Math.min(verticalFov, Math.atan(Math.tan(verticalFov) * this.camera.aspect));
    const distance = THREE.MathUtils.clamp(radius / Math.sin(framingFov) * 1.08, 160, 1100);
    // A slow, front-facing orbital arc keeps chronological direction readable.
    const yaw = this.flat ? 0 : -.65 + this.cutoff * 1.3;
    const elevation = this.flat ? 0 : .16 + Math.sin(this.cutoff * Math.PI) * .12;
    const angle = Math.atan2(Math.sin(yaw - this.playbackSphere.theta), Math.cos(yaw - this.playbackSphere.theta));
    this.playbackSphere.theta += angle * (1 - Math.exp(-1.5 * delta));
    this.playbackSphere.phi = THREE.MathUtils.damp(this.playbackSphere.phi, Math.PI / 2 - elevation, 1.5, delta);
    this.playbackSphere.radius = THREE.MathUtils.damp(this.playbackSphere.radius, distance, 1.25, delta);
    this.controls.target.lerp(this.playbackFocus, 1 - Math.exp(-2.1 * delta));
    this.camera.position.copy(this.controls.target).add(this.playbackOffset.setFromSpherical(this.playbackSphere));
    return true;
  }

  private addLines(positions: number[], colors: number[], opacity: number, group = this.graphGroup) {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, clippingPlanes: group !== this.filesGroup ? [this.clipPlane] : [] });
    if (group !== this.filesGroup) material.onBeforeCompile = (shader) => {
      shader.uniforms.uTimelineCutoff = this.lineUniforms.uCutoff;
      shader.uniforms.uGraphReveal = this.lineUniforms.uReveal;
      shader.vertexShader = `varying float vTimelineX;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTimelineX = position.x;');
      shader.fragmentShader = `varying float vTimelineX; uniform float uTimelineCutoff; uniform float uGraphReveal;\n${shader.fragmentShader}`.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= smoothstep(0.0, 4.0, uTimelineCutoff - vTimelineX) * uGraphReveal;');
    };
    group.add(new THREE.LineSegments(geometry, material));
  }

  private edgeCurve(a: [number, number, number], b: [number, number, number]) {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const midX = (a[0] + b[0]) / 2;
    const height = Math.abs(a[1] - b[1]) < 8 ? 9 : 0;
    return new THREE.CubicBezierCurve3(from, new THREE.Vector3(midX, a[1] + height, a[2]), new THREE.Vector3(midX, b[1] + height, b[2]), to);
  }

  private addLabel(text: string, point: THREE.Vector3, color: string, priority = false) {
    const element = document.createElement('div');
    element.className = priority ? 'scene-label selected-label' : 'scene-label';
    element.textContent = text;
    element.style.setProperty('--label-color', color);
    this.labelLayer.append(element);
    this.labels.push({ element, point, priority });
  }

  select(id: string | null) {
    this.dirty = true;
    this.selected = id;
    clearGroup(this.selectionGroup);
    clearGroup(this.filesGroup);
    this.fileMesh = undefined;
    this.fileOffsets = [];
    this.labels = this.labels.filter((label) => { if (label.priority) label.element.remove(); return !label.priority; });
    const node = id ? this.nodeByID.get(id) : undefined;
    if (!node) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(node.radius * 2.1, node.radius * 2.35, 48), new THREE.MeshBasicMaterial({ color: '#e1fff4', side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.position.fromArray(node.position);
    ring.name = 'selection-ring';
    this.selectionGroup.add(ring);
    const positions: number[] = [], colors: number[] = [];
    for (const edge of this.graph.edges.filter((e) => e.from === id || e.to === id)) {
      const from = this.nodeByID.get(edge.from)!;
      const to = this.nodeByID.get(edge.to)!;
      this.appendSegments(this.edgeCurve(from.position, to.position).getPoints(30), new THREE.Color('#f3dfbd').multiplyScalar(1.8), positions, colors);
    }
    this.addLines(positions, colors, 1, this.selectionGroup);
    this.addLabel(node.session.title.slice(0, 52), new THREE.Vector3(...node.position).add(new THREE.Vector3(0, 6, 0)), '#e6f3ef', true);
  }

  setFiles(files: FileChange[]) {
    this.dirty = true;
    clearGroup(this.filesGroup);
    this.fileMesh = undefined;
    this.fileOffsets = [];
    const node = this.selected ? this.nodeByID.get(this.selected) : undefined;
    if (!node) return;
    const positions: number[] = [], delays: number[] = [];
    const shown = files.slice(0, 80);
    if (!shown.length) return;
    const geometry = new THREE.OctahedronGeometry(0.55);
    const material = new THREE.MeshBasicMaterial({ color: '#edc899' });
    const mesh = new THREE.InstancedMesh(geometry, material, shown.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    this.fileMesh = mesh;
    this.fileBorn = this.time;
    this.fileOrigin.fromArray(node.position);
    this.fileUniforms.uOrigin.value.copy(this.fileOrigin);
    this.fileUniforms.uBorn.value = this.fileBorn;
    const transform = new THREE.Object3D();
    shown.forEach((file, index) => {
      const angle = index * 2.399963;
      const radius = 9 + Math.sqrt(index) * 2.5;
      const point: [number, number, number] = [node.position[0] + Math.cos(angle) * radius, node.position[1] + Math.sin(angle) * radius, node.position[2] + 6 + hash(file.path) * 8];
      this.fileOffsets.push(new THREE.Vector3(...point).sub(this.fileOrigin));
      transform.position.fromArray(point);
      transform.scale.setScalar(this.motion ? 0 : 1);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      const curve = this.edgeCurve(node.position, point).getPoints(24);
      for (let i = 1; i < curve.length; i++) {
        positions.push(...curve[i - 1].toArray(), ...curve[i].toArray());
        delays.push(index * 0.018, index * 0.018);
      }
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.filesGroup.add(mesh);
    if (positions.length) {
      const trails = new THREE.BufferGeometry();
      trails.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      trails.setAttribute('delay', new THREE.Float32BufferAttribute(delays, 1));
      const trailMaterial = new THREE.ShaderMaterial({
        uniforms: this.fileUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        vertexShader: `attribute float delay; uniform vec3 uOrigin; uniform float uTime; uniform float uBorn; uniform float uMotion; varying float vAlpha;
          void main() { float t = uMotion > .5 ? clamp((uTime-uBorn-delay)/.85,0.0,1.0) : 1.0; float p = 1.0-pow(1.0-t,3.0);
          vec3 offset = (position-uOrigin)*p; float a = uMotion > .5 ? sin(uTime*.22)*.035 : 0.0;
          offset.xy = mat2(cos(a),sin(a),-sin(a),cos(a))*offset.xy;
          vAlpha = smoothstep(0.0,.3,t)*.34; gl_Position = projectionMatrix*modelViewMatrix*vec4(uOrigin+offset,1.0); }`,
        fragmentShader: 'varying float vAlpha; void main(){gl_FragColor=vec4(.78,.57,.32,vAlpha);}',
      });
      this.filesGroup.add(new THREE.LineSegments(trails, trailMaterial));
    }
  }

  focus(id: string) {
    const node = this.nodeByID.get(id);
    if (!node) return;
    const target = new THREE.Vector3(...node.position);
    if (this.flat) target.z = 0;
    this.targetLook = target;
    const distance = THREE.MathUtils.clamp(this.camera.position.distanceTo(this.controls.target) * 0.65, 80, 180);
    this.targetPosition = target.clone().add(new THREE.Vector3(0, this.flat ? 0 : 20, distance));
  }

  reset() {
    if (!this.graph.nodes.length) return;
    const bounds = new THREE.Box3().setFromPoints(this.graph.nodes.map((node) => new THREE.Vector3(...node.position)));
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    if (this.flat) center.z = 0;
    const tangent = 2 * Math.tan(THREE.MathUtils.degToRad(22.5));
    const vertical = (size.y + 30) / tangent;
    const horizontal = (size.x + 50) / (tangent * this.camera.aspect);
    const distance = Math.max(vertical, horizontal, 100) + (this.flat ? 0 : size.z / 2 + 20);
    this.targetLook = center;
    this.targetPosition = center.clone().add(new THREE.Vector3(this.flat ? 0 : 18, this.flat ? 0 : 45, distance));
  }

  setFlat(flat: boolean) {
    this.dirty = true;
    this.flat = flat;
    this.controls.enableRotate = !flat;
    for (const group of [this.graphGroup, this.selectionGroup, this.filesGroup]) group.scale.z = flat ? 0.001 : 1;
    if (!this.playing || !this.motion) this.reset();
  }

  setMotion(enabled: boolean) {
    this.motion = enabled;
    if (enabled && this.playing) this.playbackSphere.setFromVector3(this.camera.position.clone().sub(this.controls.target));
    this.labelLayer.dataset.motion = String(enabled);
    this.revealsActive = this.graph.nodes.length > 0;
    this.dirty = true;
  }

  setSuspended(suspended: boolean) { this.suspended = suspended; this.previousFrame = performance.now(); this.dirty = true; }

  diagnostics() {
    return {
      camera: this.camera.position.toArray(), target: this.controls.target.toArray(),
      nodes: this.graph.nodes.length, edges: this.graph.edges.length,
      xRange: [Math.min(...this.graph.nodes.map((n) => n.position[0])), Math.max(...this.graph.nodes.map((n) => n.position[0]))],
      yRange: [Math.min(...this.graph.nodes.map((n) => n.position[1])), Math.max(...this.graph.nodes.map((n) => n.position[1]))],
      calls: this.renderer.info.render.calls,
      geometries: this.renderer.info.memory.geometries,
      msaaSamples: this.composer.renderTarget1.samples,
      smaa: this.smaa.enabled,
      pixelRatio: this.renderer.getPixelRatio(),
      cutoff: this.cutoff,
      selectedVisible: this.selectionGroup.visible,
      renderedFrames: this.renderer.info.render.frame,
      revealingNodes: this.revealsActive,
      revealedNodes: this.nodeReveal.filter((value) => value > 0.95).length,
      fileSatellites: this.fileOffsets.length,
      fileRevealProgress: this.motion ? Math.min(1, (this.time - this.fileBorn) / (0.85 + this.fileOffsets.length * 0.018)) : 1,
      motion: this.motion,
      suspended: this.suspended,
      playbackFollowing: this.playing && this.motion && Boolean(this.playbackPath),
      playbackFocus: this.playbackFocus.toArray(),
      flat: this.flat,
    };
  }

  setCutoff(ratio: number) {
    this.dirty = true;
    this.cutoff = THREE.MathUtils.clamp(ratio, 0, 1);
    if (!this.nodeMesh) return;
    const cutoffX = ratio * 300 - 150 + 0.001;
    this.clipPlane.constant = cutoffX;
    this.lineUniforms.uCutoff.value = ratio >= 1 ? 160 : cutoffX;
    this.revealsActive = true;
    const selected = this.selected ? this.nodeByID.get(this.selected) : undefined;
    if (selected && selected.position[0] <= cutoffX && !this.filesGroup.visible) {
      this.fileBorn = this.time;
      this.fileUniforms.uBorn.value = this.fileBorn;
    }
    this.selectionGroup.visible = this.filesGroup.visible = !selected || selected.position[0] <= cutoffX;
    if (this.glowMaterial) this.glowMaterial.uniforms.uCutoff.value = cutoffX;
  }

  private animateNodes(delta: number) {
    if (!this.nodeMesh || !this.revealsActive) return;
    let active = false;
    for (let i = 0; i < this.graph.nodes.length; i++) {
      const node = this.graph.nodes[i];
      const delay = (node.position[0] + 150) / 300 * .45;
      const target = node.position[0] <= this.clipPlane.constant && (!this.motion || this.time - this.graphBorn >= delay) ? 1 : 0;
      const old = this.nodeReveal[i];
      let value = this.motion ? THREE.MathUtils.damp(old, target, target ? 9 : 14, delta) : target;
      if (Math.abs(value - target) < .002) value = target;
      if (value !== target || (this.motion && this.time - this.graphBorn < .46)) active = true;
      this.nodeReveal[i] = value;
      this.transform.position.fromArray(node.position);
      this.transform.scale.setScalar(node.radius * value * (1 + Math.sin(value * Math.PI) * .12));
      this.transform.updateMatrix();
      this.nodeMesh.setMatrixAt(i, this.transform.matrix);
    }
    this.nodeMesh.instanceMatrix.needsUpdate = true;
    if (this.revealAttribute) this.revealAttribute.needsUpdate = true;
    this.revealsActive = active;
  }

  private animateFiles() {
    this.fileUniforms.uTime.value = this.time;
    this.fileUniforms.uMotion.value = Number(this.motion);
    if (!this.fileMesh) return;
    const angle = this.motion ? Math.sin(this.time * .22) * .035 : 0;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    this.fileOffsets.forEach((offset, i) => {
      const t = this.motion ? THREE.MathUtils.clamp((this.time - this.fileBorn - i * .018) / .85, 0, 1) : 1;
      const p = 1 - (1 - t) ** 3;
      this.transform.position.set((offset.x * cos - offset.y * sin) * p, (offset.x * sin + offset.y * cos) * p, offset.z * p).add(this.fileOrigin);
      this.transform.scale.setScalar(p);
      this.transform.rotation.set(this.motion ? this.time * .18 + i : 0, this.motion ? this.time * .24 + i : 0, Math.PI / 4);
      this.transform.updateMatrix();
      this.fileMesh!.setMatrixAt(i, this.transform.matrix);
    });
    this.fileMesh.instanceMatrix.needsUpdate = true;
    this.transform.rotation.set(0, 0, 0);
  }

  private pick(event: PointerEvent): GraphNode | null {
    if (!this.nodeMesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.nodeMesh)[0];
    if (hit?.instanceId !== undefined && this.graph.nodes[hit.instanceId].position[0] <= this.clipPlane.constant) return this.graph.nodes[hit.instanceId];
    // Small lights remain easy to pick without enlarging their visual geometry.
    let closest: GraphNode | null = null;
    let distance = event.pointerType === 'touch' ? 12 : 6;
    const point = new THREE.Vector3();
    for (const node of this.graph.nodes) {
      if (node.position[0] > this.clipPlane.constant) continue;
      point.fromArray(node.position);
      if (this.flat) point.z *= 0.001;
      point.project(this.camera);
      if (point.z < -1 || point.z > 1) continue;
      const d = Math.hypot((point.x - this.pointer.x) * rect.width / 2, (point.y - this.pointer.y) * rect.height / 2);
      if (d < distance) { closest = node; distance = d; }
    }
    return closest;
  }

  private pointerStart = (event: PointerEvent) => this.pointerDown.set(event.clientX, event.clientY);
  private pointerEnd = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (this.pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
    const node = this.pick(event);
    if (node) this.onSelect(node.session.id);
  };
  private pointerMove = (event: PointerEvent) => {
    if (event.buttons) return;
    const node = this.pick(event);
    this.hovered = node?.session.id || null;
    this.renderer.domElement.style.cursor = node ? 'pointer' : 'grab';
    const rect = this.container.getBoundingClientRect();
    this.onHover(node, event.clientX - rect.left, event.clientY - rect.top);
  };
  private pointerLeave = () => { this.hovered = null; this.onHover(null, 0, 0); };
  private doubleClick = () => { if (this.selected) this.focus(this.selected); };

  private resize() {
    this.dirty = true;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    if (this.glowMaterial) this.glowMaterial.uniforms.uScale.value = height * this.renderer.getPixelRatio() * 0.9;
  }

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const delta = Math.min(.05, (now - this.previousFrame) / 1000);
    this.previousFrame = now;
    if (document.hidden || this.suspended) return;
    this.time += delta;
    const followingPlayback = this.animatePlaybackCamera(delta);
    const animatingCamera = followingPlayback || Boolean(this.targetPosition);
    if (this.targetPosition && this.targetLook) {
      const ease = this.motion ? 1 - Math.exp(-4.7 * delta) : 1;
      this.camera.position.lerp(this.targetPosition, ease);
      this.controls.target.lerp(this.targetLook, ease);
      if (this.camera.position.distanceTo(this.targetPosition) < 0.05) { this.targetPosition = undefined; this.targetLook = undefined; }
    }
    const changed = this.controls.update();
    if (!this.dirty && !changed && !animatingCamera && !this.revealsActive && !(this.motion && this.selected && this.selectionGroup.visible)) return;
    this.animateNodes(delta);
    this.animateFiles();
    this.lineUniforms.uReveal.value = this.motion ? THREE.MathUtils.smoothstep(this.time - this.graphBorn, 0, .9) : 1;
    const ring = this.selectionGroup.getObjectByName('selection-ring');
    if (ring) {
      ring.quaternion.copy(this.camera.quaternion);
      ring.scale.setScalar(this.motion ? 1 + Math.sin(this.time * 2) * 0.07 : 1);
    }
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const occupied: { x: number; y: number; width: number }[] = [];
    for (const label of [...this.labels].sort((a, b) => Number(Boolean(b.priority)) - Number(Boolean(a.priority)))) {
      const world = label.point.clone();
      if (this.flat) world.z = 0;
      const point = world.project(this.camera);
      const labelWidth = label.priority ? Math.min(260, width - 24) : 155;
      const projectedX = (point.x * 0.5 + 0.5) * width;
      const x = label.priority ? THREE.MathUtils.clamp(projectedX - labelWidth / 2, 12, width - labelWidth - 12) : projectedX;
      const y = (-point.y * 0.5 + 0.5) * height;
      const overlaps = occupied.some((box) => x < box.x + box.width + 8 && x + labelWidth + 8 > box.x && Math.abs(y - box.y) < 26);
      const visible = (width > 600 || label.priority) && !overlaps && x + labelWidth <= width - 12 && label.point.x <= this.clipPlane.constant && point.z < 1 && point.z > -1 && Math.abs(point.x) < 0.95 && Math.abs(point.y) < 0.9;
      label.element.classList.toggle('visible', visible);
      if (visible) {
        label.element.style.transform = `translate(${x}px, ${y}px)`;
        occupied.push({ x, y, width: labelWidth });
      }
    }
    this.composer.render();
    this.dirty = false;
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((object) => {
      const drawable = object as THREE.Mesh;
      if (object instanceof THREE.InstancedMesh) object.dispose();
      drawable.geometry?.dispose();
      if (drawable.material) (Array.isArray(drawable.material) ? drawable.material : [drawable.material]).forEach((material) => material.dispose());
    });
    for (const pass of this.composer.passes) pass.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelLayer.remove();
  }
}
