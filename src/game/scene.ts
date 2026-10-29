// Cena 3D (Three.js): pista neon, luzes reagindo aos eventos do mapa, notas,
// bombas, paredes, sabres com rastro e efeitos de corte, com bloom.
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { Beatmap, FLAG_DOT, CUT_ANY, KIND_BOMB, KIND_CHAIN_LINK, NoteData } from "../core/map";
import { NoteState } from "../core/judge";
import { prefs } from "../prefs";
import { HandSaber } from "../core/saber";
import { Vec2 } from "../core/vec";

export const LANE_W = 0.6;
export const LAYER_H = 0.55;
export const GRID_Y0 = 0.55;
const NOTE_SIZE = 0.45;
const MAX_Z = 80;

export const COLOR_LEFT = new THREE.Color(0xff1f4b);
export const COLOR_RIGHT = new THREE.Color(0x1f8fff);
const ENV_RED = new THREE.Color(0xff2240);
const ENV_BLUE = new THREE.Color(0x2a8cff);
const ENV_WHITE = new THREE.Color(0xd8d8ff);
const FOG = new THREE.Color(0x07031a);

export const gridToWorld = (lane: number, layer: number, z = 0) =>
  new THREE.Vector3((lane - 2) * LANE_W, GRID_Y0 + layer * LAYER_H, z);

/** Distancia (m) do objeto ao plano de corte quando falta `dt` s (voo rapido + salto). */
export function objectZ(dt: number, map: Beatmap) {
  const hjd = map.halfJumpSeconds;
  if (dt <= hjd) return dt * map.njs;
  return hjd * map.njs + (dt - hjd) * 60;
}

const easeOut = (t: number) => {
  t = Math.min(1, Math.max(0, t));
  return 1 - (1 - t) * (1 - t);
};

// ---------------------------------------------------------------------------
// luzes do ambiente (eventos 0..4 dos mapas)
// ---------------------------------------------------------------------------
interface Light { color: THREE.Color; level: number; base: number; mode: 0 | 1 | 2 }

class EnvLights {
  lights: Light[] = [];
  private next = 0;
  private map: Beatmap | null = null;
  constructor() { this.reset(null); }
  reset(map: Beatmap | null) {
    this.map = map;
    this.next = 0;
    this.lights = [0, 1, 2, 3, 4].map((i) => ({ color: (i & 1 ? ENV_BLUE : ENV_RED).clone(), level: 0.6, base: 0.6, mode: 0 as const }));
  }
  update(t: number, dt: number, bpm: number) {
    const m = this.map;
    if (m && m.events.length) {
      while (this.next < m.events.length && m.events[this.next].time <= t) {
        const e = m.events[this.next++];
        const l = this.lights[e.type];
        const bright = e.brightness > 0 ? e.brightness : 1;
        if (e.value === 0) { l.level = l.base = 0; l.mode = 0; continue; }
        l.color.copy(e.value <= 4 ? ENV_BLUE : e.value <= 8 ? ENV_RED : ENV_WHITE);
        switch ((e.value - 1) % 4) {
          case 1: l.mode = 1; l.level = 1.6 * bright; l.base = bright; break;
          case 2: l.mode = 2; l.level = 1.6 * bright; l.base = 0; break;
          default: l.mode = 0; l.level = l.base = bright;
        }
      }
      for (const l of this.lights) {
        if (l.mode === 1) l.level = Math.max(l.base, l.level - dt * 2);
        else if (l.mode === 2) l.level = Math.max(0, l.level - dt * 1.4);
      }
    } else {
      // sem eventos: pulsa no ritmo, alternando as cores a cada compasso
      const beat = (t * bpm) / 60;
      const frac = beat - Math.floor(beat);
      const bar = Math.floor(beat / 4);
      this.lights.forEach((l, i) => {
        l.color.copy((bar + i) & 1 ? ENV_BLUE : ENV_RED);
        l.level = t < 0 ? 0.5 : 0.45 + 0.7 * Math.exp(-frac * 5);
      });
    }
  }
}

// ---------------------------------------------------------------------------
interface NoteVisual { group: THREE.Group; body: THREE.Mesh; edges: THREE.LineSegments; arrow: THREE.Mesh; dot: THREE.Mesh; bomb: THREE.Mesh }
interface Debris { mesh: THREE.Mesh; vel: THREE.Vector3; spin: THREE.Vector3; life: number }
interface SaberVisual { group: THREE.Group; blade: THREE.Mesh; glow: THREE.Mesh; glow2: THREE.Mesh; trail: THREE.Mesh; tips: THREE.Vector3[]; bases: THREE.Vector3[]; color: THREE.Color; cross: THREE.Group }

export class GameScene {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 200);
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private lights = new EnvLights();
  private notePool: NoteVisual[] = [];
  private wallPool: { mesh: THREE.Mesh; edges: THREE.LineSegments }[] = [];
  private debris: Debris[] = [];
  private sparks: THREE.Points;
  private sparkData: { pos: Float32Array; vel: Float32Array; life: Float32Array; col: Float32Array; next: number };
  private sabers: SaberVisual[] = [];
  private envMats: { lasersL: THREE.MeshBasicMaterial; lasersR: THREE.MeshBasicMaterial; rings: THREE.MeshBasicMaterial; ringsGlow: THREE.MeshBasicMaterial; back: THREE.MeshBasicMaterial; center: THREE.MeshBasicMaterial; horizon: THREE.MeshBasicMaterial };
  private lasers: THREE.Mesh[] = [];
  private gridLines: THREE.LineSegments;
  private flash = 0;
  private flashColor = new THREE.Color();
  private floorFlash: THREE.Mesh;
  private shake = 0;
  private mats: Record<string, THREE.Material> = {};
  private halfGeo = new THREE.BoxGeometry(1, 0.5, 1); // metade do cubo (destrocos), reutilizada
  private quality = 0;
  private size = { w: 1280, h: 720 };
  map: Beatmap | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance", stencil: false });
    this.renderer.setPixelRatio(1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.scene.background = FOG.clone();
    this.scene.fog = new THREE.Fog(FOG, 20, MAX_Z);
    this.camera.position.set(0, 1.55, 2.7);
    this.camera.lookAt(0, 1.05, -6);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1280, 720), 1.0, 0.55, 0.15);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0x8090ff, 0x100818, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 4, 3);
    this.scene.add(key);

    this.envMats = {
      lasersL: this.glowMat(ENV_RED), lasersR: this.glowMat(ENV_BLUE), rings: this.glowMat(ENV_BLUE),
      ringsGlow: this.glowMat(ENV_BLUE, 0.25), back: this.glowMat(ENV_RED), center: this.glowMat(ENV_BLUE),
      horizon: this.glowMat(ENV_RED, 0.5),
    };
    this.gridLines = this.buildEnvironment();
    this.floorFlash = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 4), this.glowMat(new THREE.Color(1, 1, 1), 0));
    this.floorFlash.rotation.x = -Math.PI / 2;
    this.floorFlash.position.set(0, 0.06, 0);
    this.scene.add(this.floorFlash);
    this.buildNoteResources();
    for (let i = 0; i < 2; i++) this.sabers.push(this.buildSaber(i === 0 ? COLOR_LEFT : COLOR_RIGHT));

    // faiscas (pool circular de particulas aditivas)
    const N = 400;
    this.sparkData = { pos: new Float32Array(N * 3), vel: new Float32Array(N * 3), life: new Float32Array(N), col: new Float32Array(N * 3), next: 0 };
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(this.sparkData.pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(this.sparkData.col, 3));
    this.sparks = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.sparks.frustumCulled = false;
    this.scene.add(this.sparks);
  }

  private glowMat(c: THREE.Color, opacity = 1) {
    return new THREE.MeshBasicMaterial({ color: c.clone(), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, fog: true });
  }

  setBloom(strength: number) { this.bloom.strength = strength; }

  /** 0 = desempenho (render direto, sem bloom), 1 = bloom em meia resolucao, 2 = completo. */
  setQuality(q: number) {
    this.quality = q;
    this.renderer.setPixelRatio(q >= 2 ? Math.min(window.devicePixelRatio, 2) : 1);
    this.resize(this.size.w, this.size.h);
  }

  resize(w: number, h: number) {
    this.size = { w, h };
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    if (this.quality === 1) this.bloom.setSize(Math.round(w / 2), Math.round(h / 2));
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  private buildEnvironment() {
    const s = this.scene;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshBasicMaterial({ color: 0x0b0718 }));
    floor.rotation.x = -Math.PI / 2;
    s.add(floor);
    // plataforma do jogador com bordas neon
    const plat = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.06, 4.4), new THREE.MeshLambertMaterial({ color: 0x18142e }));
    plat.position.set(0, 0.03, 0.4);
    s.add(plat);
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, 4.4), this.glowMat(side < 0 ? COLOR_LEFT : COLOR_RIGHT));
      edge.position.set(side * 1.35, 0.07, 0.4);
      s.add(edge);
    }
    // faixas centrais (grupo 4) ao longo da pista
    for (const side of [-1, 1]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.01, MAX_Z), this.envMats.center);
      strip.position.set(side * 1.3, 0.02, -MAX_Z / 2);
      s.add(strip);
    }
    // grade do chao: longitudinais fixas + transversais que correm (atualizadas por frame)
    const pts: number[] = [];
    for (const x of [2.6, 4, 5.8, 8.2, 11]) for (const sx of [-1, 1]) pts.push(sx * x, 0.01, 3, sx * x, 0.01, -MAX_Z);
    for (let k = 0; k < 14; k++) pts.push(-14, 0.01, 0, 14, 0.01, 0);
    const gg = new THREE.BufferGeometry();
    gg.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const grid = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0x7a4cff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    s.add(grid);
    // lasers laterais (grupos 2 e 3)
    for (const side of [-1, 1]) {
      for (let k = 0; k < 3; k++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(0.07, 14, 0.07), side < 0 ? this.envMats.lasersL : this.envMats.lasersR);
        m.position.set(side * (4.6 + k * 1.2), 5, -12 - k * 16);
        m.userData = { side, k };
        this.lasers.push(m);
        s.add(m);
      }
    }
    // aneis (grupo 1): cada anel e uma unica peca (moldura quadrada com furo)
    const r = 6, t = 0.1;
    const shape = new THREE.Shape([new THREE.Vector2(-r, -r), new THREE.Vector2(r, -r), new THREE.Vector2(r, r), new THREE.Vector2(-r, r)]);
    shape.holes.push(new THREE.Path([new THREE.Vector2(-r + t, -r + t), new THREE.Vector2(-r + t, r - t), new THREE.Vector2(r - t, r - t), new THREE.Vector2(r - t, -r + t)]));
    const ringGeo = new THREE.ShapeGeometry(shape);
    for (let k = 0; k < 5; k++) {
      const ring = new THREE.Mesh(ringGeo, this.envMats.rings);
      ring.position.set(0, 3.2, -16 - k * 12);
      s.add(ring);
    }
    // X gigante ao fundo (grupo 0) + brilho do horizonte
    for (const sgn of [-1, 1]) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 40, 0.1), this.envMats.back);
      bar.position.set(0, 8, -70);
      bar.rotation.z = sgn * 0.85;
      s.add(bar);
    }
    return grid;
  }

  private buildNoteResources() {
    const body = new RoundedBoxGeometry(1, 1, 1, 2, 0.1);
    const edgesGeo = new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 1.02));
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(-0.32, -0.02);
    arrowShape.lineTo(0, 0.3);
    arrowShape.lineTo(0.32, -0.02);
    arrowShape.lineTo(0.2, -0.02);
    arrowShape.lineTo(0, 0.17);
    arrowShape.lineTo(-0.2, -0.02);
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    const dotGeo = new THREE.CircleGeometry(0.15, 20);
    const bombGeo = new THREE.IcosahedronGeometry(0.42, 0);
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    this.mats.white = white;
    for (const [name, c] of [["L", COLOR_LEFT], ["R", COLOR_RIGHT]] as const) {
      this.mats["body" + name] = new THREE.MeshLambertMaterial({ color: c.clone().multiplyScalar(0.6), emissive: c, emissiveIntensity: 0.5 });
      this.mats["edge" + name] = new THREE.LineBasicMaterial({ color: c.clone().multiplyScalar(2.2), toneMapped: false });
      this.mats["miss" + name] = new THREE.MeshLambertMaterial({ color: c.clone().multiplyScalar(0.15), transparent: true, opacity: 0.6 });
    }
    this.mats.bomb = new THREE.MeshLambertMaterial({ color: 0x2a2a34, emissive: 0x330010, flatShading: true });
    for (let i = 0; i < 96; i++) {
      const group = new THREE.Group();
      const b = new THREE.Mesh(body, this.mats.bodyL);
      const e = new THREE.LineSegments(edgesGeo, this.mats.edgeL as THREE.LineBasicMaterial);
      const a = new THREE.Mesh(arrowGeo, white);
      a.position.z = 0.505;
      const d = new THREE.Mesh(dotGeo, white);
      d.position.z = 0.505;
      const bomb = new THREE.Mesh(bombGeo, this.mats.bomb);
      group.add(b, e, a, d, bomb);
      group.visible = false;
      this.scene.add(group);
      this.notePool.push({ group, body: b, edges: e, arrow: a, dot: d, bomb });
    }
    const wallMat = new THREE.MeshBasicMaterial({ color: 0xff2050, transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const wallEdge = new THREE.LineBasicMaterial({ color: new THREE.Color(0xff3060).multiplyScalar(2), toneMapped: false });
    const box = new THREE.BoxGeometry(1, 1, 1);
    const boxEdges = new THREE.EdgesGeometry(box);
    for (let i = 0; i < 24; i++) {
      const mesh = new THREE.Mesh(box, wallMat);
      const edges = new THREE.LineSegments(boxEdges, wallEdge);
      mesh.visible = edges.visible = false;
      this.scene.add(mesh, edges);
      this.wallPool.push({ mesh, edges });
    }
  }

  private buildSaber(color: THREE.Color): SaberVisual {
    const group = new THREE.Group();
    const len = 1.1;
    const hilt = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.26, 12), new THREE.MeshLambertMaterial({ color: 0x6a6d80 }));
    hilt.position.y = -0.13;
    const blade = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 10), new THREE.MeshBasicMaterial({ color: color.clone().lerp(new THREE.Color(1, 1, 1), 0.7).multiplyScalar(1.6), toneMapped: false }));
    blade.position.y = len / 2;
    const glow = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, len, 12), this.glowMat(color.clone().multiplyScalar(1.5), 0.55));
    glow.position.y = len / 2;
    const glow2 = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, len * 1.02, 12), this.glowMat(color, 0.14));
    glow2.position.y = len / 2;
    group.add(hilt, blade, glow, glow2);
    this.scene.add(group);
    // rastro: fita de N segmentos (ponta e base dos ultimos quadros)
    const N = 12;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(N * 2 * 3), 3));
    const alpha = new Float32Array(N * 2 * 4);
    tg.setAttribute("color", new THREE.BufferAttribute(alpha, 4));
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
    tg.setIndex(idx);
    const trail = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    trail.frustumCulled = false;
    this.scene.add(trail);
    // mira no plano de corte
    const cross = new THREE.Group();
    const cm = this.glowMat(color.clone().multiplyScalar(1.8), 0.9);
    const h = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.02), cm);
    const v = new THREE.Mesh(new THREE.PlaneGeometry(0.02, 0.22), cm);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.115, 24), cm);
    cross.add(h, v, ring);
    this.scene.add(cross);
    return { group, blade, glow, glow2, trail, tips: [], bases: [], color, cross };
  }

  // ---------------------------------------------------------------------------
  setMap(map: Beatmap | null) {
    this.map = map;
    this.lights.reset(map);
    for (const n of this.notePool) n.group.visible = false;
    for (const w of this.wallPool) w.mesh.visible = w.edges.visible = false;
    for (const d of this.debris) this.scene.remove(d.mesh);
    this.debris = [];
    for (const s of this.sabers) { s.tips = []; s.bases = []; }
  }

  flashCut(color: THREE.Color) {
    this.flash = 1;
    this.flashColor.copy(color);
  }

  addShake(v: number) { this.shake = Math.max(this.shake, v); }

  /** Efeito de corte: 2 metades voando + faiscas. */
  spawnCut(note: NoteData, t: number, dir: Vec2, colorIdx: number) {
    const map = this.map;
    if (!map) return;
    const pos = gridToWorld(note.x + 0.5, note.y + 0.5, -objectZ(note.time - t, map));
    const color = colorIdx === 0 ? COLOR_LEFT : COLOR_RIGHT;
    const mat = colorIdx === 0 ? this.mats.bodyL : this.mats.bodyR;
    const n = new THREE.Vector3(-dir.y, dir.x, 0).normalize(); // normal do plano de corte
    for (const sgn of [-1, 1]) {
      const mesh = new THREE.Mesh(this.halfGeo, mat);
      mesh.scale.setScalar(NOTE_SIZE);
      const ang = Math.atan2(dir.y, dir.x) - Math.PI / 2;
      mesh.rotation.z = ang;
      mesh.position.copy(pos).addScaledVector(n, sgn * NOTE_SIZE * 0.26);
      this.scene.add(mesh);
      this.debris.push({
        mesh,
        vel: n.clone().multiplyScalar(sgn * 1.8).add(new THREE.Vector3(dir.x * 1.2, dir.y * 1.2 + 0.8, 2.5)),
        spin: new THREE.Vector3(Math.random() * 6 - 3, Math.random() * 6 - 3, sgn * 6),
        life: 0.7,
      });
    }
    this.burst(pos, color, 16, 3.2, dir);
    this.flashCut(color);
  }

  burst(pos: THREE.Vector3, color: THREE.Color, count: number, speed: number, dir?: Vec2) {
    const d = this.sparkData;
    const N = d.life.length;
    for (let i = 0; i < count; i++) {
      const k = d.next;
      d.next = (d.next + 1) % N;
      d.pos[k * 3] = pos.x; d.pos[k * 3 + 1] = pos.y; d.pos[k * 3 + 2] = pos.z;
      const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      if (dir) v.add(new THREE.Vector3(dir.x, dir.y, 0).multiplyScalar(speed * 0.6));
      d.vel[k * 3] = v.x; d.vel[k * 3 + 1] = v.y; d.vel[k * 3 + 2] = v.z + 1.5;
      d.life[k] = 0.35 + Math.random() * 0.4;
      const c = color.clone().lerp(new THREE.Color(1, 1, 1), Math.random() * 0.5).multiplyScalar(2);
      d.col[k * 3] = c.r; d.col[k * 3 + 1] = c.g; d.col[k * 3 + 2] = c.b;
    }
  }

  private updateSparks(dt: number) {
    const d = this.sparkData;
    for (let k = 0; k < d.life.length; k++) {
      if (d.life[k] <= 0) continue;
      d.life[k] -= dt;
      if (d.life[k] <= 0) {
        d.col[k * 3] = d.col[k * 3 + 1] = d.col[k * 3 + 2] = 0;
        continue;
      }
      d.vel[k * 3 + 1] -= 5 * dt;
      for (let a = 0; a < 3; a++) d.pos[k * 3 + a] += d.vel[k * 3 + a] * dt;
      const fade = Math.min(1, d.life[k] * 4);
      for (let a = 0; a < 3; a++) d.col[k * 3 + a] *= 0.96 + 0.04 * fade;
    }
    this.sparks.geometry.attributes.position.needsUpdate = true;
    this.sparks.geometry.attributes.color.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  /** Atualiza ambiente, notas, paredes, sabres e efeitos para o tempo `t` da musica. */
  update(t: number, frameDt: number, noteState: Uint8Array | null, firstNote: number, sabers: HandSaber[]) {
    const map = this.map;
    const dt = Math.min(0.1, Math.max(0, frameDt));
    this.lights.update(t, dt, map?.bpm ?? 120);
    this.updateEnvironment(t);
    if (map && noteState) {
      this.updateNotes(map, t, noteState, firstNote);
      this.updateWalls(map, t);
    }
    this.updateSabers(sabers);
    // destrocos
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const db = this.debris[i];
      db.life -= dt;
      db.vel.y -= 6 * dt;
      db.mesh.position.addScaledVector(db.vel, dt);
      db.mesh.rotation.x += db.spin.x * dt;
      db.mesh.rotation.y += db.spin.y * dt;
      db.mesh.rotation.z += db.spin.z * dt;
      db.mesh.scale.setScalar(NOTE_SIZE * Math.max(0.01, Math.min(1, db.life * 2.5)));
      if (db.life <= 0) {
        this.scene.remove(db.mesh);
        this.debris.splice(i, 1);
      }
    }
    this.updateSparks(dt);
    this.flash = Math.max(0, this.flash - dt * 4);
    const fm = this.floorFlash.material as THREE.MeshBasicMaterial;
    fm.color.copy(this.flashColor);
    fm.opacity = this.flash * 0.25;
    this.shake = Math.max(0, this.shake - dt * 0.5);
    const sh = this.shake > 0 ? Math.sin(performance.now() * 0.09) * this.shake : 0;
    this.camera.position.set(sh, 1.55 + sh * 0.5, 2.7);
    this.camera.lookAt(sh * 0.5, 1.05, -6);
  }

  private lightColor(group: number, extra = 1) {
    const l = this.lights.lights[group];
    return { color: l.color, a: Math.min(1, Math.max(0, l.level * extra * 0.8)) };
  }

  private updateEnvironment(t: number) {
    const set = (m: THREE.MeshBasicMaterial, g: number, mul = 1) => {
      const { color, a } = this.lightColor(g);
      m.color.copy(color).multiplyScalar(1.6);
      m.opacity = a * mul;
    };
    set(this.envMats.lasersL, 2);
    set(this.envMats.lasersR, 3);
    set(this.envMats.rings, 1);
    set(this.envMats.ringsGlow, 1, 0.25);
    set(this.envMats.back, 0);
    set(this.envMats.center, 4);
    set(this.envMats.horizon, 0, 0.35);
    for (const m of this.lasers) {
      const { side, k } = m.userData as { side: number; k: number };
      m.position.x = side * (4.6 + k * 0.7) + Math.sin(t * 0.7 + k) * 0.6;
      m.rotation.z = Math.sin(t * 0.4 + k * 1.3) * 0.12 * side;
    }
    // grade transversal correndo em direcao ao jogador
    const pos = this.gridLines.geometry.attributes.position as THREE.BufferAttribute;
    const run = ((Math.max(t, 0) * 9) % 4 + 4) % 4; // passo de 4 m = espacamento das linhas
    const base = 5 * 2 * 2; // pontos das longitudinais
    for (let k = 0; k < 14; k++) {
      const z = 3 - k * 4 + run;
      pos.setZ(base + k * 2, z);
      pos.setZ(base + k * 2 + 1, z);
    }
    pos.needsUpdate = true;
  }

  private updateNotes(map: Beatmap, t: number, state: Uint8Array, first: number) {
    const horizon = map.halfJumpSeconds + 0.45;
    const hjd = Math.max(0.05, map.halfJumpSeconds);
    let used = 0;
    for (let i = Math.max(0, first - 8); i < map.notes.length && used < this.notePool.length; i++) {
      const n = map.notes[i];
      const dtNote = n.time - t;
      if (dtNote > horizon) break;
      const st = state[i];
      if (st === NoteState.CutGood || st === NoteState.CutBad || st === NoteState.BombHit) continue;
      const z = objectZ(dtNote, map);
      if (z < -3.2) continue;
      const v = this.notePool[used++];
      const target = gridToWorld(n.x + 0.5, n.y + 0.5, -z);
      const p = dtNote > 0 ? Math.min(1, Math.max(0, 1 - dtNote / hjd)) : 1;
      const rise = easeOut(p / 0.5);
      v.group.position.set(target.x, THREE.MathUtils.lerp(0.3, target.y, rise), target.z);
      const spin = (1 - easeOut(p / 0.4)) * Math.PI;
      v.group.visible = true;
      const bomb = n.kind === KIND_BOMB;
      v.bomb.visible = bomb;
      v.body.visible = v.edges.visible = !bomb;
      if (bomb) {
        v.arrow.visible = v.dot.visible = false;
        v.group.scale.setScalar(NOTE_SIZE);
        v.group.rotation.set(t * 1.3 + i, t * 2.1, 0);
        continue;
      }
      const left = n.color === 0;
      const missed = st === NoteState.Missed;
      v.body.material = missed ? (left ? this.mats.missL : this.mats.missR) : left ? this.mats.bodyL : this.mats.bodyR;
      v.edges.material = left ? this.mats.edgeL : this.mats.edgeR;
      v.edges.visible = !missed;
      const dot = (n.flags & FLAG_DOT) !== 0 || n.cutDir === CUT_ANY;
      const link = n.kind === KIND_CHAIN_LINK;
      v.arrow.visible = !dot && !link && !missed;
      v.dot.visible = (dot || link) && !missed;
      const rot = ((dot ? n.angle : n.angle - 90) * Math.PI) / 180 + spin;
      v.group.rotation.set(0, 0, rot);
      v.group.scale.set(NOTE_SIZE, link ? NOTE_SIZE * 0.32 : NOTE_SIZE, NOTE_SIZE);
    }
    for (let k = used; k < this.notePool.length; k++) this.notePool[k].group.visible = false;
  }

  private updateWalls(map: Beatmap, t: number) {
    const horizon = map.halfJumpSeconds + 0.45;
    let used = 0;
    for (const o of map.obstacles) {
      if (o.time - t > horizon) break;
      if (o.time + o.duration < t - 1) continue;
      if (used >= this.wallPool.length) break;
      let z0 = objectZ(o.time - t, map), z1 = objectZ(o.time + o.duration - t, map);
      if (z1 < -2.6) continue;
      z0 = Math.max(z0, -2.6);
      z1 = Math.min(z1, MAX_Z);
      const x0 = (o.x - 2) * LANE_W, x1 = (o.x + o.w - 2) * LANE_W;
      const y0 = o.y <= 0 ? 0 : GRID_Y0 + (o.y - 0.5) * LAYER_H;
      const y1 = GRID_Y0 + (o.y + o.h - 0.5) * LAYER_H;
      const w = this.wallPool[used++];
      for (const m of [w.mesh, w.edges]) {
        m.visible = true;
        m.position.set((x0 + x1) / 2, (y0 + y1) / 2, -(z0 + z1) / 2);
        m.scale.set(Math.max(0.01, x1 - x0), Math.max(0.01, y1 - y0), Math.max(0.01, z1 - z0));
      }
    }
    for (let k = used; k < this.wallPool.length; k++) this.wallPool[k].mesh.visible = this.wallPool[k].edges.visible = false;
  }

  private updateSabers(sabers: HandSaber[]) {
    const up = new THREE.Vector3(0, 1, 0);
    this.sabers.forEach((v, i) => {
      const s = sabers[i];
      const visible = !!s && s.tracked;
      v.group.visible = v.cross.visible = v.trail.visible = visible;
      if (!visible) { v.tips = []; v.bases = []; return; }
      const p = s.predict(performance.now(), prefs.predictionMs / 1000);
      const target = gridToWorld(Math.min(6, Math.max(-2, p.x)), Math.min(4.5, Math.max(-1.5, p.y)), -0.3);
      // o cabo acompanha a mao (meio caminho entre o lado do jogador e o alvo)
      const side = i === 0 ? -1 : 1;
      const hilt = new THREE.Vector3(side * 0.28 + target.x * 0.35, 0.55 + (target.y - 1) * 0.3, 1.35);
      const dir = target.clone().sub(hilt).normalize();
      v.group.position.copy(hilt);
      v.group.quaternion.setFromUnitVectors(up, dir);
      const speed = Math.min(1, s.speed / 500);
      (v.glow2.material as THREE.MeshBasicMaterial).opacity = 0.12 + speed * 0.12;
      v.cross.position.set(gridToWorld(p.x, p.y).x, gridToWorld(p.x, p.y).y, 0);
      // rastro
      const tip = hilt.clone().addScaledVector(dir, 1.1);
      const base = hilt.clone().addScaledVector(dir, 0.35);
      v.tips.unshift(tip);
      v.bases.unshift(base);
      const N = 12;
      if (v.tips.length > N) { v.tips.pop(); v.bases.pop(); }
      const pos = v.trail.geometry.attributes.position as THREE.BufferAttribute;
      const col = v.trail.geometry.attributes.color as THREE.BufferAttribute;
      for (let k = 0; k < N; k++) {
        const tk = v.tips[Math.min(k, v.tips.length - 1)];
        const bk = v.bases[Math.min(k, v.bases.length - 1)];
        pos.setXYZ(k * 2, tk.x, tk.y, tk.z);
        pos.setXYZ(k * 2 + 1, bk.x, bk.y, bk.z);
        const a = (1 - k / (N - 1)) * 0.6 * speed;
        col.setXYZW(k * 2, v.color.r * 1.5, v.color.g * 1.5, v.color.b * 1.5, a);
        col.setXYZW(k * 2 + 1, v.color.r, v.color.g, v.color.b, 0);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    });
  }

  /** Posicao na tela (px) de um ponto da grade, para os textos flutuantes. */
  projectGrid(lane: number, layer: number, w: number, h: number) {
    const v = gridToWorld(lane, layer, 0).project(this.camera);
    return { x: (v.x * 0.5 + 0.5) * w, y: (0.5 - v.y * 0.5) * h };
  }

  render() {
    if (this.quality === 0 || this.bloom.strength <= 0.01) this.renderer.render(this.scene, this.camera);
    else this.composer.render();
  }
}
