import type { Lab } from '@bax-print/core';

const DEG = Math.PI / 180;
const POW25_7 = 25 ** 7;

function hueDegrees(b: number, aPrime: number): number {
  if (b === 0 && aPrime === 0) return 0;
  const h = Math.atan2(b, aPrime) / DEG;
  return h < 0 ? h + 360 : h;
}

/**
 * CIEDE2000 colour difference (CIE 142-2001), following the published formulation and
 * implementation notes of Sharma, Wu and Dalal (2005).
 */
export function deltaE2000(x: Lab, y: Lab, kL = 1, kC = 1, kH = 1): number {
  const c1 = Math.hypot(x.a, x.b);
  const c2 = Math.hypot(y.a, y.b);
  const cBar7 = ((c1 + c2) / 2) ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + POW25_7)));
  const a1p = (1 + g) * x.a;
  const a2p = (1 + g) * y.a;
  const c1p = Math.hypot(a1p, x.b);
  const c2p = Math.hypot(a2p, y.b);
  const h1p = hueDegrees(x.b, a1p);
  const h2p = hueDegrees(y.b, a2p);
  const chromaProduct = c1p * c2p;

  const dLp = y.L - x.L;
  const dCp = c2p - c1p;
  let dhp = 0;
  if (chromaProduct !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(chromaProduct) * Math.sin((dhp / 2) * DEG);

  const lBarP = (x.L + y.L) / 2;
  const cBarP = (c1p + c2p) / 2;
  let hBarP = h1p + h2p;
  if (chromaProduct !== 0) {
    if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2;
    else hBarP = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
  }

  const t =
    1 -
    0.17 * Math.cos((hBarP - 30) * DEG) +
    0.24 * Math.cos(2 * hBarP * DEG) +
    0.32 * Math.cos((3 * hBarP + 6) * DEG) -
    0.2 * Math.cos((4 * hBarP - 63) * DEG);
  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2));
  const cBarP7 = cBarP ** 7;
  const rC = 2 * Math.sqrt(cBarP7 / (cBarP7 + POW25_7));
  const lOffset = (lBarP - 50) ** 2;
  const sL = 1 + (0.015 * lOffset) / Math.sqrt(20 + lOffset);
  const sC = 1 + 0.045 * cBarP;
  const sH = 1 + 0.015 * cBarP * t;
  const rT = -Math.sin(2 * dTheta * DEG) * rC;

  const lTerm = dLp / (kL * sL);
  const cTerm = dCp / (kC * sC);
  const hTerm = dHp / (kH * sH);
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rT * cTerm * hTerm);
}
