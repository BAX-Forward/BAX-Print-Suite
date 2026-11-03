/**
 * A deliberately small SVG subset for custom mark symbols: `path`, `rect`,
 * `circle`, `ellipse`, `line`, `polyline` and `polygon` with `fill`, `stroke`
 * and `stroke-width`, sized by `viewBox` (or `width`/`height`). Everything is
 * painted in the marks colorant. Transforms, styles, text and images are not
 * supported and are reported as warnings.
 */
import { MarkSpecError } from "./errors.js";

export type PathCommand =
  | { readonly op: "M" | "L"; readonly x: number; readonly y: number }
  | { readonly op: "C"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly x: number; readonly y: number }
  | { readonly op: "Z" };

export interface SvgShape {
  readonly commands: PathCommand[];
  readonly fill: boolean;
  readonly stroke: boolean;
  /** In viewBox units. */
  readonly strokeWidth: number;
}

export interface SvgSymbol {
  /** viewBox minimum corner and size (y down, as in SVG). */
  readonly viewBox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly shapes: SvgShape[];
  readonly warnings: string[];
}

const KAPPA = 0.5522847498307936;
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const IGNORED = new Set(["svg", "g", "title", "desc", "defs", "metadata", "?xml", "!--", "!DOCTYPE"]);

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    out[m[1]!] = m[3] ?? m[4] ?? "";
  }
  return out;
}

function numbers(text: string): number[] {
  return [...text.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)].map((m) => Number(m[0]));
}

const num = (v: string | undefined, fallback = 0): number => {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

function ellipse(cx: number, cy: number, rx: number, ry: number): PathCommand[] {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return [
    { op: "M", x: cx + rx, y: cy },
    { op: "C", x1: cx + rx, y1: cy + ky, x2: cx + kx, y2: cy + ry, x: cx, y: cy + ry },
    { op: "C", x1: cx - kx, y1: cy + ry, x2: cx - rx, y2: cy + ky, x: cx - rx, y: cy },
    { op: "C", x1: cx - rx, y1: cy - ky, x2: cx - kx, y2: cy - ry, x: cx, y: cy - ry },
    { op: "C", x1: cx + kx, y1: cy - ry, x2: cx + rx, y2: cy - ky, x: cx + rx, y: cy },
    { op: "Z" },
  ];
}

function polyline(points: number[], close: boolean): PathCommand[] {
  const cmds: PathCommand[] = [];
  for (let i = 0; i + 1 < points.length; i += 2) cmds.push({ op: i === 0 ? "M" : "L", x: points[i]!, y: points[i + 1]! });
  if (close && cmds.length > 0) cmds.push({ op: "Z" });
  return cmds;
}

/** Elliptical arc (SVG implementation notes F.6) as cubic Béziers. */
function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  angleDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): PathCommand[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) return [{ op: "L", x, y }];
  const phi = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x0 + x) / 2;
  const cy = sin * cxp + cos * cyp + (y0 + y) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const t = (4 / 3) * Math.tan(step / 4);
  const point = (a: number, rxs: number, rys: number) => ({
    x: cx + cos * rxs * Math.cos(a) - sin * rys * Math.sin(a),
    y: cy + sin * rxs * Math.cos(a) + cos * rys * Math.sin(a),
  });
  const deriv = (a: number) => ({
    x: -cos * rx * Math.sin(a) - sin * ry * Math.cos(a),
    y: -sin * rx * Math.sin(a) + cos * ry * Math.cos(a),
  });
  const out: PathCommand[] = [];
  for (let i = 0; i < segments; i++) {
    const a1 = theta1 + i * step;
    const a2 = a1 + step;
    const p1 = point(a1, rx, ry);
    const p2 = point(a2, rx, ry);
    const d1 = deriv(a1);
    const d2 = deriv(a2);
    out.push({ op: "C", x1: p1.x + t * d1.x, y1: p1.y + t * d1.y, x2: p2.x - t * d2.x, y2: p2.y - t * d2.y, x: p2.x, y: p2.y });
  }
  return out;
}

/** Path data (SVG 1.1 §8.3) to absolute M/L/C/Z commands. */
export function parsePathData(d: string): PathCommand[] {
  const tokens = [...d.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g)];
  const out: PathCommand[] = [];
  let i = 0;
  let cmd = "";
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCtrl: { x: number; y: number; kind: "C" | "Q" } | undefined;
  const next = () => {
    const value = tokens[i]?.[2];
    if (value === undefined) throw new MarkSpecError(`SVG path data is missing a number after "${cmd}"`);
    i++;
    return Number(value);
  };
  const flag = () => next() !== 0;
  while (i < tokens.length) {
    if (tokens[i]![1] !== undefined) cmd = tokens[i++]![1]!;
    else if (!cmd || cmd.toUpperCase() === "Z") throw new MarkSpecError("SVG path data has a number without a command");
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (cmd.toUpperCase()) {
      case "Z":
        out.push({ op: "Z" });
        cx = sx;
        cy = sy;
        lastCtrl = undefined;
        continue;
      case "M": {
        cx = ox + next();
        cy = oy + next();
        sx = cx;
        sy = cy;
        out.push({ op: "M", x: cx, y: cy });
        cmd = rel ? "l" : "L";
        lastCtrl = undefined;
        break;
      }
      case "L":
        cx = ox + next();
        cy = oy + next();
        out.push({ op: "L", x: cx, y: cy });
        lastCtrl = undefined;
        break;
      case "H":
        cx = ox + next();
        out.push({ op: "L", x: cx, y: cy });
        lastCtrl = undefined;
        break;
      case "V":
        cy = oy + next();
        out.push({ op: "L", x: cx, y: cy });
        lastCtrl = undefined;
        break;
      case "C":
      case "S": {
        let x1: number;
        let y1: number;
        if (cmd.toUpperCase() === "C") {
          x1 = ox + next();
          y1 = oy + next();
        } else {
          x1 = lastCtrl?.kind === "C" ? 2 * cx - lastCtrl.x : cx;
          y1 = lastCtrl?.kind === "C" ? 2 * cy - lastCtrl.y : cy;
        }
        const x2 = ox + next();
        const y2 = oy + next();
        cx = ox + next();
        cy = oy + next();
        out.push({ op: "C", x1, y1, x2, y2, x: cx, y: cy });
        lastCtrl = { x: x2, y: y2, kind: "C" };
        break;
      }
      case "Q":
      case "T": {
        let qx: number;
        let qy: number;
        if (cmd.toUpperCase() === "Q") {
          qx = ox + next();
          qy = oy + next();
        } else {
          qx = lastCtrl?.kind === "Q" ? 2 * cx - lastCtrl.x : cx;
          qy = lastCtrl?.kind === "Q" ? 2 * cy - lastCtrl.y : cy;
        }
        const x = ox + next();
        const y = oy + next();
        out.push({
          op: "C",
          x1: cx + (2 / 3) * (qx - cx),
          y1: cy + (2 / 3) * (qy - cy),
          x2: x + (2 / 3) * (qx - x),
          y2: y + (2 / 3) * (qy - y),
          x,
          y,
        });
        cx = x;
        cy = y;
        lastCtrl = { x: qx, y: qy, kind: "Q" };
        break;
      }
      case "A": {
        const rx = next();
        const ry = next();
        const angle = next();
        const large = flag();
        const sweep = flag();
        const x = ox + next();
        const y = oy + next();
        out.push(...arcToCubics(cx, cy, rx, ry, angle, large, sweep, x, y));
        cx = x;
        cy = y;
        lastCtrl = undefined;
        break;
      }
    }
  }
  return out;
}

function shapeCommands(name: string, a: Record<string, string>): PathCommand[] {
  switch (name) {
    case "path":
      return parsePathData(a.d ?? "");
    case "rect": {
      const x = num(a.x);
      const y = num(a.y);
      const w = num(a.width);
      const h = num(a.height);
      return polyline([x, y, x + w, y, x + w, y + h, x, y + h], true);
    }
    case "circle":
      return ellipse(num(a.cx), num(a.cy), num(a.r), num(a.r));
    case "ellipse":
      return ellipse(num(a.cx), num(a.cy), num(a.rx), num(a.ry));
    case "line":
      return polyline([num(a.x1), num(a.y1), num(a.x2), num(a.y2)], false);
    case "polyline":
    case "polygon":
      return polyline(numbers(a.points ?? ""), name === "polygon");
    default:
      return [];
  }
}

const isNone = (v: string | undefined) => v !== undefined && v.trim().toLowerCase() === "none";

export function parseSvgSymbol(svg: string): SvgSymbol {
  const warnings = new Set<string>();
  const root = /<svg\b[^>]*>/i.exec(svg);
  if (!root) throw new MarkSpecError("custom symbol is not an SVG document (no <svg> element)");
  const rootAttrs = attributes(root[0]);
  const vb = numbers(rootAttrs.viewBox ?? "");
  const viewBox =
    vb.length === 4
      ? { x: vb[0]!, y: vb[1]!, w: vb[2]!, h: vb[3]! }
      : { x: 0, y: 0, w: num(rootAttrs.width), h: num(rootAttrs.height) };
  if (!(viewBox.w > 0 && viewBox.h > 0)) throw new MarkSpecError("custom SVG symbol needs a viewBox or width and height");

  const shapes: SvgShape[] = [];
  for (const m of svg.matchAll(/<\s*([!?A-Za-z][-A-Za-z0-9:]*)([^>]*)>/g)) {
    const name = m[1]!.replace(/^svg:/, "");
    const a = attributes(m[0]);
    if (a.transform !== undefined) warnings.add(`SVG transform on <${name}> is not supported and was ignored`);
    if (a.style !== undefined) warnings.add("SVG style attributes are not supported; use fill, stroke and stroke-width");
    if (!SHAPES.has(name)) {
      if (!IGNORED.has(name) && !name.startsWith("!")) warnings.add(`SVG element <${name}> is not supported and was ignored`);
      continue;
    }
    const commands = shapeCommands(name, a);
    if (commands.length === 0) continue;
    const open = name === "line" || name === "polyline";
    shapes.push({
      commands,
      fill: !open && !isNone(a.fill),
      stroke: a.stroke !== undefined && !isNone(a.stroke),
      strokeWidth: num(a["stroke-width"], 1),
    });
  }
  if (shapes.length === 0) throw new MarkSpecError("custom SVG symbol contains no supported shapes");
  return { viewBox, shapes, warnings: [...warnings] };
}
