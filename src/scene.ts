import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { connectionPositions, hash, timeX, trailPosition } from './layout';
import { createNodeMaterial, nodeColor, nodeEmphasisShader } from './node-appearance';
import { DEFAULT_PREFERENCES, motionEnabled, type Preferences } from './preferences';
import type { FileChange, Graph, GraphNode } from './types';
import type { TimelineItem, TimelineSummary } from './timeline';
import { ScreenGrid } from './screen-grid';
import { eventIcon } from './event-icons';

type Label = { element: HTMLDivElement; point: THREE.Vector3; priority?: boolean; visible?: boolean; transform?: string };

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
  private nodeMesh?: THREE.InstancedMesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private nodeByID = new Map<string, GraphNode>();
  private nodeIndices = new Map<string, number>();
  private focusUniforms = { uSelected: { value: -1 }, uHovered: { value: -1 }, uFocus: { value: 0 } };
  private raycaster = new THREE.Raycaster();
  private nodeGrid = new ScreenGrid<{ index: number; x: number; y: number }>();
  private markerGrid = new ScreenGrid<{ index: number; x: number; y: number }>();
  private pickingDirty = true;
  private pickingView = new THREE.Matrix4();
  private pickingProjection = new THREE.Matrix4();
  private pickMesh?: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private pickMatrix = new THREE.Matrix4();
  private pickHits: THREE.Intersection[] = [];
  private width = 1;
  private height = 1;
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
  private eventMarkers: { item: TimelineSummary; position: THREE.Vector3 }[] = [];
  private selectedEvent: string | null = null;
  private focusedEvent?: TimelineSummary;
  private focusedSession: string | null = null;
  private eventIcons: { element: HTMLDivElement; marker: number; visible: boolean; transform: string }[] = [];
  private iconPoint = new THREE.Vector3();
  private markerUniforms = { uPixelRatio: { value: 1 }, uSelected: { value: -1 }, uHovered: { value: -1 } };
  private fileOffsets: THREE.Vector3[] = [];
  private fileOrigin = new THREE.Vector3();
  private fileBorn = 0;
  private fileUniforms = { uTime: { value: 0 }, uBorn: { value: 0 }, uMotion: { value: 1 }, uOrigin: { value: new THREE.Vector3() } };
  private lineUniforms = { uCutoff: { value: 160 }, uReveal: { value: 1 } };
  private preferences: Preferences = { ...DEFAULT_PREFERENCES };
  private trailUniforms = { uTrailTime: { value: 0 }, uTrailFlow: { value: 0 }, uTrailSpeed: { value: .5 }, uTrailOpacity: { value: 1 } };
  private stars?: THREE.Points;
  private transform = new THREE.Object3D();
  private onSelect: (id: string) => void;
  private onHover: (node: GraphNode | null, x: number, y: number) => void;
  private onEvent: (id: string) => void;
  private onEventHover: (item: TimelineSummary | null, count: number, x: number, y: number) => void;

  constructor(private container: HTMLElement, callbacks: {
    onSelect: (id: string) => void;
    onHover: (node: GraphNode | null, x: number, y: number) => void;
    onPlaybackInterrupt: () => void;
    onEvent: (id: string) => void;
    onEventHover: (item: TimelineSummary | null, count: number, x: number, y: number) => void;
  }) {
    this.onSelect = callbacks.onSelect;
    this.onHover = callbacks.onHover;
    this.onEvent = callbacks.onEvent;
    this.onEventHover = callbacks.onEventHover;
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
      this.focusedSession = null;
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
    this.stars = new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#7b9fa9', size: 0.4, transparent: true, opacity: 0.18, sizeAttenuation: true }));
    this.scene.add(this.stars);
  }

  applyPreferences(values: Preferences) {
    const previous = this.preferences;
    this.preferences = { ...values };
    const motion = motionEnabled(values, matchMedia('(prefers-reduced-motion: reduce)').matches);
    if (motion !== this.motion) this.setMotion(motion);
    if ((values.view === '2d') !== this.flat) this.setFlat(values.view === '2d');
    if (values.quality !== previous.quality) {
      const ratio = values.quality === 'performance' ? 1 : values.quality === 'high' ? Math.min(Math.max(devicePixelRatio, 2), 2.5) : Math.min(Math.max(devicePixelRatio, 1.5), 2);
      const samples = values.quality === 'performance' ? 0 : Math.min(4, this.renderer.capabilities.maxSamples);
      for (const target of [this.composer.renderTarget1, this.composer.renderTarget2]) { target.samples = samples; target.dispose(); }
      this.smaa.enabled = values.quality !== 'performance';
      this.renderer.setPixelRatio(ratio); this.composer.setPixelRatio(ratio); this.resize();
    }
    this.bloom.strength = values.bloom / 100; this.bloom.enabled = values.quality !== 'performance' && values.bloom > 0;
    if (this.stars) this.stars.visible = values.stars;
    this.labelLayer.hidden = !values.labels;
    this.trailUniforms.uTrailOpacity.value = values.trailOpacity / 42;
    this.trailUniforms.uTrailSpeed.value = values.trailSpeed / 100;
    for (const group of [this.graphGroup, this.selectionGroup]) for (const object of group.children) {
      if (object.userData.kind === 'lifetime') object.visible = values.trails === 'all' || (values.trails === 'selected' && group === this.selectionGroup);
      if (object.userData.kind === 'relationship') object.visible = values.relationships;
    }
    const markers = this.selectionGroup.getObjectByName('event-markers'); if (markers) markers.visible = values.messageDots;
    if (this.nodeMesh && previous.nodeScale !== values.nodeScale) { this.nodeMesh.boundingSphere = null; this.revealsActive = true; }
    this.dirty = true;
  }

  setGraph(graph: Graph, fit = false) {
    this.pickingDirty = true;
    this.dirty = true;
    clearGroup(this.graphGroup);
    clearGroup(this.selectionGroup);
    clearGroup(this.filesGroup);
    this.eventMarkers = [];
    this.eventIcons = [];
    this.fileMesh = undefined;
    this.fileOffsets = [];
    this.labels = [];
    this.labelLayer.replaceChildren();
    this.graph = graph;
    this.playbackPath = undefined; this.playbackRadii = [];
    this.nodeByID = new Map(graph.nodes.map((node) => [node.session.id, node]));
    this.nodeIndices = new Map(graph.nodes.map((node, index) => [node.session.id, index]));
    this.focusUniforms.uSelected.value = this.selected ? this.nodeIndices.get(this.selected) ?? -1 : -1;
    this.focusUniforms.uHovered.value = -1;
    this.hovered = null;
    this.nodeMesh = undefined;
    this.pickMesh = undefined;
    this.glowMaterial = undefined;
    this.graphBorn = this.time;
    this.nodeReveal = new Float32Array(graph.nodes.length).fill(this.motion ? 0 : 1);
    this.revealsActive = this.motion && graph.nodes.length > 0;
    if (!graph.nodes.length) return;
    const geometry = new THREE.SphereGeometry(1, 32, 20);
    const indices = Float32Array.from(graph.nodes, (_, index) => index);
    geometry.setAttribute('nodeIndex', new THREE.InstancedBufferAttribute(indices, 1));
    const mesh = new THREE.InstancedMesh(geometry, createNodeMaterial(this.focusUniforms), graph.nodes.length);
    // Flatten node centers, not the spheres themselves: coplanar surfaces flicker
    // and lose their separating silhouettes when overlapping in 2D.
    mesh.scale.z = this.flat ? 1000 : 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const transform = new THREE.Object3D();
    const glowPositions: number[] = [], glowColors: number[] = [], glowSizes: number[] = [];
    graph.nodes.forEach((node, index) => {
      transform.position.fromArray(node.position);
      if (this.flat) transform.position.z *= .001;
      transform.scale.setScalar(node.radius * this.preferences.nodeScale / 100);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      const color = nodeColor(node);
      mesh.setColorAt(index, color);
      glowPositions.push(...node.position);
      glowColors.push(...color.toArray());
      glowSizes.push(node.radius * 11);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    this.nodeMesh = mesh;
    this.pickMesh = new THREE.Mesh(geometry, mesh.material);
    this.graphGroup.add(mesh);
    const glowGeometry = new THREE.BufferGeometry();
    glowGeometry.setAttribute('position', new THREE.Float32BufferAttribute(glowPositions, 3));
    glowGeometry.setAttribute('color', new THREE.Float32BufferAttribute(glowColors, 3));
    glowGeometry.setAttribute('size', new THREE.Float32BufferAttribute(glowSizes, 1));
    glowGeometry.setAttribute('nodeIndex', new THREE.BufferAttribute(indices, 1));
    this.revealAttribute = new THREE.BufferAttribute(this.nodeReveal, 1).setUsage(THREE.DynamicDrawUsage);
    glowGeometry.setAttribute('reveal', this.revealAttribute);
    this.glowMaterial = new THREE.ShaderMaterial({
      uniforms: { ...this.focusUniforms, uCutoff: { value: 151 }, uScale: { value: this.container.clientHeight * this.renderer.getPixelRatio() * 0.9 } },
      vertexShader: `${nodeEmphasisShader}
        attribute float size; attribute float reveal; varying vec3 vColor; varying float vVisible; uniform float uScale; uniform float uCutoff;
        void main() { vColor = color; vVisible = reveal; vNodeEmphasis = nodeEmphasis(); vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = clamp(size * (1.0 + sin(reveal * 3.14159) * .45) * uScale / -mv.z, 2.0, 100.0); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying vec3 vColor; varying float vVisible; varying float vNodeEmphasis;
        void main() { float d = length(gl_PointCoord - .5) * 2.0; if (d > 1.0) discard;
        float a = pow(1.0 - d, 3.1) * .34 * vVisible * vNodeEmphasis; gl_FragColor = vec4(vColor * 1.15, a); }`,
      vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.graphGroup.add(new THREE.Points(glowGeometry, this.glowMaterial));

    // A lifetime trail belongs to one session. Its endpoint shares the node's
    // exact center, including after descendant placement and depth flattening.
    const trailPositions: number[] = [], trailColors: number[] = [];
    for (const node of graph.nodes) {
      this.appendSegments([new THREE.Vector3(...node.startPosition), new THREE.Vector3(...node.position)], nodeColor(node), trailPositions, trailColors);
    }
    this.addLines(trailPositions, trailColors, 0.42, this.graphGroup, 'lifetime');
    graph.lanes.forEach((lane, index) => {
      const firstX = Math.min(...lane.nodes.map((node) => node.startPosition[0]));
      if (index < 12) this.addLabel(lane.label, new THREE.Vector3(firstX - 4, lane.y + 8, lane.z), lane.color);
    });

    const edgePositions: number[] = [], edgeColors: number[] = [];
    for (const edge of graph.edges) {
      const from = this.nodeByID.get(edge.from)!;
      const to = this.nodeByID.get(edge.to)!;
      const curve = this.edgeCurve(...connectionPositions(from, to));
      this.appendSegments(curve.getPoints(22), new THREE.Color(edge.kind === 'fork' ? '#edbc8d' : '#bda6ef'), edgePositions, edgeColors);
    }
    this.addLines(edgePositions, edgeColors, 0.7, this.graphGroup, 'relationship');

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
    if (playing) { this.focusedSession = null; this.camera.clearViewOffset(); }
    if (playing && this.motion) {
      if (!this.playbackPath) this.buildPlaybackPath();
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
    // Sweep a half-turn around the activity frontier, ending on the far side.
    const yaw = this.flat ? 0 : -.3 + this.cutoff * Math.PI;
    const elevation = this.flat ? 0 : .16 + Math.sin(this.cutoff * Math.PI) * .12;
    const angle = Math.atan2(Math.sin(yaw - this.playbackSphere.theta), Math.cos(yaw - this.playbackSphere.theta));
    this.playbackSphere.theta += angle * (1 - Math.exp(-3 * delta));
    this.playbackSphere.phi = THREE.MathUtils.damp(this.playbackSphere.phi, Math.PI / 2 - elevation, 1.5, delta);
    this.playbackSphere.radius = THREE.MathUtils.damp(this.playbackSphere.radius, distance, 1.25, delta);
    this.controls.target.lerp(this.playbackFocus, 1 - Math.exp(-2.1 * delta));
    this.camera.position.copy(this.controls.target).add(this.playbackOffset.setFromSpherical(this.playbackSphere));
    return true;
  }

  private addLines(positions: number[], colors: number[], opacity: number, group = this.graphGroup, kind = 'grid') {
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, clippingPlanes: group !== this.filesGroup ? [this.clipPlane] : [] });
    if (group !== this.filesGroup) material.onBeforeCompile = (shader) => {
      shader.uniforms.uTimelineCutoff = this.lineUniforms.uCutoff;
      shader.uniforms.uGraphReveal = this.lineUniforms.uReveal;
      shader.uniforms.uContextFocus = group === this.graphGroup ? this.focusUniforms.uFocus : { value: 0 };
      Object.assign(shader.uniforms, this.trailUniforms);
      shader.vertexShader = `varying float vTimelineX;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTimelineX = position.x;');
      shader.fragmentShader = `varying float vTimelineX; uniform float uTimelineCutoff; uniform float uGraphReveal; uniform float uContextFocus;\n${shader.fragmentShader}`.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= smoothstep(0.0, 4.0, uTimelineCutoff - vTimelineX) * uGraphReveal * mix(1.0, .45, uContextFocus);');
      if (kind === 'lifetime') shader.fragmentShader = `uniform float uTrailTime; uniform float uTrailFlow; uniform float uTrailSpeed; uniform float uTrailOpacity;\n${shader.fragmentShader}`.replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.a *= uTrailOpacity * mix(1.0, .84 + .16 * pow(.5 + .5 * sin(vTimelineX * .28 - uTrailTime * uTrailSpeed * 2.2), 4.0), uTrailFlow);');
    };
    material.customProgramCacheKey = () => kind;
    const lines = new THREE.LineSegments(geometry, material); lines.userData.kind = kind;
    lines.visible = kind === 'lifetime' ? this.preferences.trails === 'all' || (this.preferences.trails === 'selected' && group === this.selectionGroup) : kind !== 'relationship' || this.preferences.relationships;
    group.add(lines);
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
    const label = { element, point, priority };
    if (priority) this.labels.unshift(label); else this.labels.push(label);
  }

  select(id: string | null) {
    this.pickingDirty = true;
    this.dirty = true;
    if (this.selected !== id) { this.selectedEvent = null; this.focusedEvent = undefined; }
    this.selected = id;
    this.focusUniforms.uSelected.value = id ? this.nodeIndices.get(id) ?? -1 : -1;
    clearGroup(this.selectionGroup);
    clearGroup(this.filesGroup);
    this.eventMarkers = [];
    this.clearEventIcons();
    this.fileMesh = undefined;
    this.fileOffsets = [];
    this.labels = this.labels.filter((label) => { if (label.priority) label.element.remove(); return !label.priority; });
    const node = id ? this.nodeByID.get(id) : undefined;
    if (!node) return;
    const ring = new THREE.Mesh(new THREE.RingGeometry(node.radius * 2.1, node.radius * 2.35, 96), new THREE.MeshBasicMaterial({ color: '#e1fff4', side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    ring.position.fromArray(node.position);
    ring.name = 'selection-ring';
    this.selectionGroup.add(ring);
    const positions: number[] = [], colors: number[] = [];
    const trail: number[] = [], trailColors: number[] = [];
    this.appendSegments([new THREE.Vector3(...node.startPosition), new THREE.Vector3(...node.position)], nodeColor(node).multiplyScalar(1.4), trail, trailColors);
    this.addLines(trail, trailColors, 1, this.selectionGroup, 'lifetime');
    for (const edge of this.graph.edges.filter((e) => e.from === id || e.to === id)) {
      const from = this.nodeByID.get(edge.from)!;
      const to = this.nodeByID.get(edge.to)!;
      this.appendSegments(this.edgeCurve(...connectionPositions(from, to)).getPoints(30), new THREE.Color('#f3dfbd').multiplyScalar(1.8), positions, colors);
    }
    this.addLines(positions, colors, 1, this.selectionGroup, 'relationship');
    this.addLabel(node.session.title.slice(0, 52), new THREE.Vector3(...node.position).add(new THREE.Vector3(0, 6, 0)), '#e6f3ef', true);
    this.setCutoff(this.cutoff);
  }

  setEvents(items: TimelineSummary[]) {
    this.pickingDirty = true;
    const old = this.selectionGroup.getObjectByName('event-markers');
    if (old) { clearGroup(old as THREE.Group); old.removeFromParent(); }
    this.eventMarkers = [];
    this.clearEventIcons();
    this.dirty = true;
    const node = this.selected ? this.nodeByID.get(this.selected) : undefined;
    if (!node) return;
    const positions: number[] = [];
    const shown = items.slice(-2000);
    // A paginated selection can be older than the marker overview's bound.
    if (this.focusedEvent && !shown.some((item) => item.id === this.focusedEvent!.id)) shown.push(this.focusedEvent);
    for (const item of shown) {
      if (item.time === null) continue;
      // The session sphere already represents its latest message.
      if (item.kind === 'message' && item.time === node.session.activity?.lastMessageAt) continue;
      const x = timeX(item.time, this.graph);
      if (!Number.isFinite(x) || x < node.startPosition[0] || x > node.position[0]) continue;
      const position = new THREE.Vector3(...trailPosition(node, x));
      this.eventMarkers.push({ item, position }); positions.push(...position.toArray());
    }
    if (!positions.length) return;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('markerIndex', new THREE.Float32BufferAttribute(this.eventMarkers.map((_, i) => i), 1));
    this.markerUniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.markerUniforms.uHovered.value = -1;
    this.selectEvent(this.selectedEvent);
    const material = new THREE.ShaderMaterial({
      uniforms: { uCutoff: this.lineUniforms.uCutoff, ...this.markerUniforms },
      transparent: true, depthWrite: false, depthTest: false,
      vertexShader: `uniform float uPixelRatio; uniform float uSelected; uniform float uHovered; attribute float markerIndex; varying float vTimeX; varying float vActive;
        void main() { vTimeX = position.x; vActive = float(abs(markerIndex-uSelected)<.1 || abs(markerIndex-uHovered)<.1); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = mix(6.5,10.0,vActive) * uPixelRatio; }`,
      fragmentShader: `uniform float uCutoff; varying float vTimeX; varying float vActive;
        void main() { float d = length(gl_PointCoord - .5) * 2.0; if (d > 1.0 || vTimeX > uCutoff) discard;
        gl_FragColor = vec4(vec3(1.3 + vActive * .2), 1.0 - smoothstep(.5, 1.0, d)); }`,
    });
    const group = new THREE.Group(); group.name = 'event-markers'; group.visible = this.preferences.messageDots;
    const points = new THREE.Points(geometry, material); points.renderOrder = 10;
    group.add(points); this.selectionGroup.add(group);
    // Bound DOM work independently of the 2,000-dot GPU/picking budget.
    const recent = this.eventMarkers.length - 1, chosen = new Set<number>();
    for (let i = recent; i >= Math.max(0, recent - 31); i--) chosen.add(i);
    for (let i = 0; i < 32 && recent > 31; i++) chosen.add(Math.floor(i * (recent - 32) / 31));
    for (const marker of [...chosen].sort((a, b) => b - a)) {
      const element = document.createElement('div'); element.className = 'event-marker-icon'; element.setAttribute('aria-hidden', 'true');
      element.append(eventIcon(this.eventMarkers[marker].item)); this.labelLayer.append(element);
      this.eventIcons.push({ element, marker, visible: false, transform: '' });
    }
    if (this.focusedSession === this.selected && this.selected) this.focus(this.selected);
  }

  private clearEventIcons() { for (const icon of this.eventIcons) icon.element.remove(); this.eventIcons = []; }

  selectEvent(id: string | null) { this.selectedEvent = id; if (!id) this.focusedEvent = undefined; this.markerUniforms.uSelected.value = this.eventMarkers.findIndex((marker) => marker.item.id === id); this.dirty = true; }

  focusEvent(item: TimelineItem | TimelineSummary) {
    this.focusedSession = null;
    const node = this.selected ? this.nodeByID.get(this.selected) : undefined;
    if (!node || item.time === null) return;
    const x = timeX(item.time, this.graph);
    if (!Number.isFinite(x) || x < node.startPosition[0] || x > node.position[0]) return;
    this.focusedEvent = { ...item, preview: 'preview' in item ? item.preview : (item.text || item.input || item.output || '').slice(0, 180) };
    if (!this.eventMarkers.some((marker) => marker.item.id === item.id)) this.setEvents(this.eventMarkers.map((marker) => marker.item));
    this.selectEvent(item.id);
    this.focusPoint(new THREE.Vector3(...trailPosition(node, x)), 100);
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
    if (this.selected !== id) this.select(id);
    this.focusedSession = id;
    const recent = this.eventMarkers.filter((marker) => marker.item.kind === 'message').slice(-12);
    const length = node.position[0] - node.startPosition[0];
    const span = Math.min(length, 60, Math.max(8, recent.length ? node.position[0] - recent[0].position.x : Math.min(40, length * .3)));
    const target = new THREE.Vector3(...node.position); target.x -= span / 2;
    const area = this.focusArea();
    const distance = Math.max(85, (span + 18) * this.height / Math.max(160, area.width) / (2 * Math.tan(Math.PI / 8)));
    this.focusPoint(target, Math.min(distance, 220));
  }

  private focusPoint(target: THREE.Vector3, distance: number) {
    if (this.flat) target.z = 0;
    this.frameFocus();
    this.targetLook = target;
    this.targetPosition = target.clone().add(new THREE.Vector3(0, this.flat ? 0 : 20, distance));
    this.dirty = true;
  }

  private focusArea() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    let left = 16, right = width - 16, top = width >= 760 ? 92 : 72, bottom = height - 24;
    const inspector = document.getElementById('inspector'), explorer = document.getElementById('explorer');
    if (width >= 760) {
      left = explorer && !explorer.hidden ? explorer.getBoundingClientRect().right + 24 : left;
      right = inspector && !inspector.hidden ? inspector.getBoundingClientRect().left - 24 : right;
      if (right - left < 160) { left = 16; right = width - 16; }
    } else if (inspector && !inspector.hidden) {
      const rect = inspector.getBoundingClientRect();
      if (rect.top > 160) bottom = Math.min(bottom, rect.top - 20);
    }
    const timeline = document.getElementById('timeline');
    if (timeline && !timeline.hidden) { const rect = timeline.getBoundingClientRect(); if (rect.top > top + 160) bottom = Math.min(bottom, rect.top - 24); }
    return { x: (left + right) / 2, y: (top + bottom) / 2, width: right - left, height: bottom - top };
  }

  private frameFocus() {
    const width = this.container.clientWidth, height = this.container.clientHeight;
    const { x, y } = this.focusArea();
    this.camera.setViewOffset(width, height, width / 2 - x, height / 2 - y, width, height);
  }

  reset() {
    this.focusedSession = null;
    this.camera.clearViewOffset();
    if (!this.graph.nodes.length) return;
    const bounds = new THREE.Box3().setFromPoints(this.graph.nodes.flatMap((node) => [new THREE.Vector3(...node.startPosition), new THREE.Vector3(...node.position)]));
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
    if (this.nodeMesh) { this.nodeMesh.scale.z = flat ? 1000 : 1; this.nodeMesh.boundingSphere = null; }
    this.revealsActive = true;
    if (!this.playing || !this.motion) this.reset();
  }

  setMotion(enabled: boolean) {
    this.motion = enabled;
    if (enabled && this.playing && !this.playbackPath) this.buildPlaybackPath();
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
      selectedNode: this.selected,
      selectedPosition: this.selected ? this.nodeByID.get(this.selected)?.position : undefined,
      focusDimming: this.focusUniforms.uFocus.value,
      nodeSegments: this.nodeMesh?.geometry.parameters.widthSegments,
      eventMarkers: this.eventMarkers.length,
      eventIcons: this.eventIcons.filter((icon) => icon.visible).length,
      focusArea: this.focusArea(),
      selectedScreen: this.selected && this.nodeByID.has(this.selected) ? (() => { const point = new THREE.Vector3(...this.nodeByID.get(this.selected)!.position); if (this.flat) point.z = 0; point.project(this.camera); return [(point.x + 1) / 2 * this.width, (1 - point.y) / 2 * this.height]; })() : undefined,
      selectedEvent: this.selectedEvent,
      selectedEventPosition: this.eventMarkers.find((marker) => marker.item.id === this.selectedEvent)?.position.toArray(),
      markerSamples: this.eventMarkers.slice(0, 30).map(({ item, position }) => { const p = position.clone(); if (this.flat) p.z *= .001; p.project(this.camera); return { id: item.id, kind: item.kind, x: (p.x + 1) / 2 * this.container.clientWidth, y: (1 - p.y) / 2 * this.container.clientHeight }; }),
      sessionTrails: this.graph.nodes.filter((node) => node.position[0] > node.startPosition[0]).length,
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
      preferences: { ...this.preferences },
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
    this.selectionGroup.visible = !selected || selected.startPosition[0] <= cutoffX;
    this.filesGroup.visible = !selected || selected.position[0] <= cutoffX;
    const ring = this.selectionGroup.getObjectByName('selection-ring');
    if (ring) ring.visible = !selected || selected.position[0] <= cutoffX;
    if (this.glowMaterial) this.glowMaterial.uniforms.uCutoff.value = cutoffX;
  }

  private animateNodes(delta: number) {
    if (!this.nodeMesh || !this.revealsActive) return;
    this.pickingDirty = true;
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
      if (this.flat) this.transform.position.z *= .001;
      this.transform.scale.setScalar(node.radius * this.preferences.nodeScale / 100 * value * (1 + Math.sin(value * Math.PI) * .12));
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

  private updatePicking() {
    if (!this.pickingDirty && this.pickingView.equals(this.camera.matrixWorldInverse) && this.pickingProjection.equals(this.camera.projectionMatrix)) return;
    this.pickingView.copy(this.camera.matrixWorldInverse); this.pickingProjection.copy(this.camera.projectionMatrix);
    this.nodeGrid.clear(); this.markerGrid.clear();
    const point = new THREE.Vector3(), view = new THREE.Vector3();
    this.graph.nodes.forEach((node, index) => {
      point.fromArray(node.position); if (this.flat) point.z *= .001;
      view.copy(point).applyMatrix4(this.camera.matrixWorldInverse); point.project(this.camera);
      if (point.z < -1 || point.z > 1) return;
      const reveal = this.nodeReveal[index], radius = node.radius * this.preferences.nodeScale / 100 * reveal * (1 + Math.sin(reveal * Math.PI) * .12);
      // Conservative perspective bounds include off-axis spheres, not just their centers.
      const depth = -view.z, denominator = Math.max(.001, depth - radius);
      const rx = this.width / 2 * Math.abs(this.camera.projectionMatrix.elements[0]) * radius * (1 + Math.abs(view.x) / depth) / denominator;
      const ry = this.height / 2 * Math.abs(this.camera.projectionMatrix.elements[5]) * radius * (1 + Math.abs(view.y) / depth) / denominator;
      const x = (point.x + 1) / 2 * this.width, y = (1 - point.y) / 2 * this.height;
      this.nodeGrid.add({ index, x, y }, x, y, Math.max(12, rx, ry), this.width, this.height);
    });
    this.eventMarkers.forEach(({ position }, index) => {
      point.copy(position); if (this.flat) point.z *= .001; point.project(this.camera);
      if (point.z < -1 || point.z > 1) return;
      const x = (point.x + 1) / 2 * this.width, y = (1 - point.y) / 2 * this.height;
      this.markerGrid.add({ index, x, y }, x, y, 22, this.width, this.height);
    });
    this.pickingDirty = false;
  }

  private pick(event: PointerEvent): GraphNode | null {
    if (!this.nodeMesh || !this.pickMesh) return null;
    this.updatePicking();
    const rect = this.renderer.domElement.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    this.pointer.set(x / this.width * 2 - 1, -y / this.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    let hit: GraphNode | null = null, nearest = Infinity, closest: GraphNode | null = null;
    let distance = event.pointerType === 'touch' ? 12 : 6;
    for (const candidate of this.nodeGrid.at(x, y)) {
      const node = this.graph.nodes[candidate.index];
      if (node.position[0] > this.clipPlane.constant) continue;
      // Test the original full-resolution sphere only for nearby candidates.
      this.nodeMesh.getMatrixAt(candidate.index, this.pickMatrix);
      this.pickMesh.matrixWorld.multiplyMatrices(this.nodeMesh.matrixWorld, this.pickMatrix);
      this.pickHits.length = 0; this.pickMesh.raycast(this.raycaster, this.pickHits);
      for (const intersection of this.pickHits) if (intersection.distance < nearest) { nearest = intersection.distance; hit = node; }
      const d = Math.hypot(candidate.x - x, candidate.y - y);
      if (d < distance) { closest = node; distance = d; }
    }
    return hit || closest;
  }

  private pointerStart = (event: PointerEvent) => { this.pointerDown.set(event.clientX, event.clientY); this.onHover(null, 0, 0); };
  private pickEvent(event: PointerEvent) {
    if (!this.preferences.messageDots || !this.selectionGroup.visible) return null;
    this.updatePicking();
    const rect = this.renderer.domElement.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
    let nearest = Infinity, selected = -1, count = 0;
    for (const candidate of this.markerGrid.at(x, y)) {
      if (this.eventMarkers[candidate.index].position.x > this.lineUniforms.uCutoff.value) continue;
      const distance = Math.hypot(candidate.x - x, candidate.y - y);
      if (distance > (event.pointerType === 'touch' ? 22 : 10)) continue;
      count++;
      if (distance < nearest) { nearest = distance; selected = candidate.index; }
    }
    return selected >= 0 ? { index: selected, item: this.eventMarkers[selected].item, count } : null;
  }
  private pointerEnd = (event: PointerEvent) => {
    if (event.button !== 0) return;
    if (this.pointerDown.distanceTo(new THREE.Vector2(event.clientX, event.clientY)) > 5) return;
    const marker = this.pickEvent(event);
    if (marker) { this.selectEvent(marker.item.id); this.onEvent(marker.item.id); this.focusEvent(marker.item); return; }
    const node = this.pick(event);
    if (node) this.onSelect(node.session.id);
  };
  private pointerMove = (event: PointerEvent) => {
    if (event.buttons) return;
    const marker = this.pickEvent(event);
    if (this.markerUniforms.uHovered.value !== (marker?.index ?? -1)) { this.markerUniforms.uHovered.value = marker?.index ?? -1; this.dirty = true; }
    const node = marker ? null : this.pick(event);
    const hovered = node?.session.id || null;
    if (hovered !== this.hovered) {
      this.hovered = hovered;
      this.focusUniforms.uHovered.value = hovered ? this.nodeIndices.get(hovered) ?? -1 : -1;
      this.dirty = true;
    }
    this.renderer.domElement.style.cursor = node || marker ? 'pointer' : 'grab';
    const rect = this.container.getBoundingClientRect();
    if (marker) this.onEventHover(marker.item, marker.count, event.clientX - rect.left, event.clientY - rect.top);
    else this.onHover(node, event.clientX - rect.left, event.clientY - rect.top);
  };
  private pointerLeave = () => { this.hovered = null; this.focusUniforms.uHovered.value = -1; this.markerUniforms.uHovered.value = -1; this.dirty = true; this.onHover(null, 0, 0); };

  private resize() {
    this.dirty = true;
    this.pickingDirty = true;
    const width = this.container.clientWidth, height = this.container.clientHeight;
    if (!width || !height) return;
    this.width = width; this.height = height;
    this.camera.aspect = width / height;
    if (this.camera.view?.enabled) this.frameFocus();
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setSize(width, height);
    this.markerUniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    if (this.glowMaterial) this.glowMaterial.uniforms.uScale.value = height * this.renderer.getPixelRatio() * 0.9;
  }

  private animate = () => {
    this.frame = requestAnimationFrame(this.animate);
    const now = performance.now();
    const delta = this.suspended ? 0 : Math.min(.05, (now - this.previousFrame) / 1000);
    this.previousFrame = now;
    if (document.hidden || (this.suspended && !this.dirty)) return;
    this.time += delta;
    const followingPlayback = this.animatePlaybackCamera(delta);
    const animatingCamera = followingPlayback || Boolean(this.targetPosition);
    if (this.targetPosition && this.targetLook) {
      const ease = this.motion && !this.suspended ? 1 - Math.exp(-4.7 * delta) : 1;
      this.camera.position.lerp(this.targetPosition, ease);
      this.controls.target.lerp(this.targetLook, ease);
      if (this.camera.position.distanceTo(this.targetPosition) < 0.05) { this.targetPosition = undefined; this.targetLook = undefined; }
    }
    const changed = this.controls.update();
    // Project labels with the same camera matrix used for this frame's nodes,
    // including immediate 2D/reset jumps when reduced motion is enabled.
    this.camera.updateMatrixWorld();
    const selected = this.selected ? this.nodeByID.get(this.selected) : undefined;
    const focusTarget = this.preferences.focusDimming && selected && selected.position[0] <= this.clipPlane.constant ? 1 : 0;
    const focusing = Math.abs(this.focusUniforms.uFocus.value - focusTarget) > .001;
    this.focusUniforms.uFocus.value = focusing && this.motion && !this.suspended ? THREE.MathUtils.damp(this.focusUniforms.uFocus.value, focusTarget, 10, delta) : focusTarget;
    const flow = this.motion && this.preferences.trailFlow && this.preferences.trails !== 'off';
    this.trailUniforms.uTrailTime.value = this.time; this.trailUniforms.uTrailFlow.value = Number(flow);
    if (!this.dirty && !changed && !animatingCamera && !focusing && !this.revealsActive && !flow && !(this.motion && this.selected && this.selectionGroup.visible)) return;
    this.animateNodes(delta);
    this.animateFiles();
    this.lineUniforms.uReveal.value = this.motion ? THREE.MathUtils.smoothstep(this.time - this.graphBorn, 0, .9) : 1;
    const ring = this.selectionGroup.getObjectByName('selection-ring');
    if (ring) {
      ring.quaternion.copy(this.camera.quaternion);
      ring.scale.setScalar(this.preferences.nodeScale / 100 * (this.motion ? 1 + Math.sin(this.time * 2) * 0.07 : 1));
    }
    const width = this.width, height = this.height;
    const occupied: { x: number; y: number; width: number }[] = [];
    for (const label of this.labels) {
      const world = label.point.clone();
      if (this.flat) world.z = 0;
      const point = world.project(this.camera);
      const labelWidth = label.priority ? Math.min(260, width - 24) : 155;
      const projectedX = (point.x * 0.5 + 0.5) * width;
      const x = label.priority ? THREE.MathUtils.clamp(projectedX - labelWidth / 2, 12, width - labelWidth - 12) : projectedX;
      const y = (-point.y * 0.5 + 0.5) * height - (label.priority ? 24 : 0);
      const overlaps = occupied.some((box) => x < box.x + box.width + 8 && x + labelWidth + 8 > box.x && Math.abs(y - box.y) < 26);
      const visible = (width > 600 || label.priority) && !overlaps && x + labelWidth <= width - 12 && label.point.x <= this.clipPlane.constant && point.z < 1 && point.z > -1 && Math.abs(point.x) < 0.95 && Math.abs(point.y) < 0.9;
      if (label.visible !== visible) { label.element.classList.toggle('visible', visible); label.visible = visible; }
      if (visible) {
        const transform = `translate(${x}px, ${y}px)`;
        if (label.transform !== transform) { label.element.style.transform = transform; label.transform = transform; }
        occupied.push({ x, y, width: labelWidth });
      }
    }
    for (const icon of this.eventIcons) {
      const marker = this.eventMarkers[icon.marker], point = this.iconPoint.copy(marker.position);
      if (this.flat) point.z = 0;
      point.project(this.camera);
      const x = (point.x + 1) / 2 * width - 6, y = (1 - point.y) / 2 * height - 25;
      const visible = this.preferences.messageDots && this.selectionGroup.visible && marker.position.x <= this.clipPlane.constant && point.z > -1 && point.z < 1 && x > 12 && x < width - 24 && y > 12 && y < height - 30 && !occupied.some((box) => x < box.x + box.width + 12 && x + 24 > box.x && Math.abs(y - box.y) < 24);
      if (visible !== icon.visible) { icon.element.classList.toggle('visible', visible); icon.visible = visible; }
      if (visible) {
        const transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
        if (transform !== icon.transform) { icon.element.style.transform = transform; icon.transform = transform; }
        occupied.push({ x, y, width: 12 });
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
