// Vetor 2D minimo (coordenadas da grade: x = lanes, y = layers; para cima = +y).
export class Vec2 {
  constructor(public x = 0, public y = 0) {}
  add(o: Vec2) { return new Vec2(this.x + o.x, this.y + o.y); }
  sub(o: Vec2) { return new Vec2(this.x - o.x, this.y - o.y); }
  scale(s: number) { return new Vec2(this.x * s, this.y * s); }
  dot(o: Vec2) { return this.x * o.x + this.y * o.y; }
  length() { return Math.hypot(this.x, this.y); }
  normalized() {
    const l = this.length();
    return l > 1e-6 ? new Vec2(this.x / l, this.y / l) : new Vec2();
  }
  clone() { return new Vec2(this.x, this.y); }
}

export const DEG = Math.PI / 180;
export const directionFromAngle = (deg: number) => new Vec2(Math.cos(deg * DEG), Math.sin(deg * DEG));

export function distancePointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const ab = b.sub(a);
  const len2 = ab.dot(ab);
  const t = len2 > 1e-8 ? Math.min(1, Math.max(0, p.sub(a).dot(ab) / len2)) : 0;
  return p.sub(a.add(ab.scale(t))).length();
}

export function angleBetween(a: Vec2, b: Vec2): number {
  return Math.acos(Math.min(1, Math.max(-1, a.dot(b)))) / DEG;
}
