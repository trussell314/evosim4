// Parse SVG path "d" attributes from the user's Inkscape drawing
// into flat vertex arrays, normalized to [0..1] over the 210x297
// viewBox. Cubic beziers are sampled into N points so the polygon
// keeps the curve.

const W = 210, H = 297;
const BEZ_SAMPLES = 8; // points per cubic bezier segment

const paths = {
  // From the user message: 3 <path> d attributes.
  ROCK_TOP_LEFT: "m -7.2532133,-1.2724935 c 0.8907454,0 38.6838053,15.5244215 38.6838053,15.5244215 l 8.907454,15.015423 c 0,0 13.870181,6.235218 14.506427,6.107969 0.636246,-0.127248 16.542417,-4.835474 17.051414,-4.962723 0.508998,-0.127251 15.015424,-8.14396 15.015424,-8.14396 L 95.946014,9.6709509 103.96272,7.88946 l 4.32648,5.217224 c 0,0 -1.65424,5.089974 -2.29049,5.471722 -0.63624,0.381748 -3.30848,4.962725 -3.30848,4.962725 0,0 -1.39974,9.289202 -1.39974,9.798199 0,0.508998 1.65424,6.489719 1.65424,6.489719 l 0.509,9.925449 -21.123396,7.507711 -13.106686,12.470437 -10.307195,12.08869 c 0,0 -7.380465,-2.417738 -7.507714,-2.926736 -0.127248,-0.508997 -12.215936,-8.143959 -12.215936,-8.143959 0,0 -4.580977,-1.908739 -5.344475,-1.78149 -0.763495,0.127249 -6.10797,5.217223 -6.10797,5.217223 l -8.398456,6.362467 c 0,0 -8.398457,4.453729 -9.289203,5.598973 C 9.1619537,87.293057 -0.63624679,98.363753 -0.63624679,98.363753 L -5.5989717,86.275062 Z",
  ROCK_RIGHT_MID: "m 215.5894,139.64722 -81.34091,18.3557 -22.31476,14.75654 -1.79958,20.51518 2.51941,12.23713 7.91814,4.31898 c 0,0 6.11857,0.71984 11.87721,-0.35991 5.75865,-1.07975 18.71561,-11.15738 18.71561,-11.15738 l 6.8384,-6.8384 8.63797,-4.6789 9.71772,2.87932 9.71772,7.55823 2.51941,3.59916 5.39873,8.99788 6.8384,4.6789 6.11856,1.43967 8.27806,1.07974 h 5.03882 z",
  ROCK_SEAFLOOR: "m 215.22949,247.62188 -35.99156,12.95696 -26.27383,5.39874 -24.11434,-0.35991 -10.79747,-10.07764 -13.67679,-20.87511 -16.196194,-20.8751 -15.836284,-2.15949 -9.717719,1.43966 -8.637974,1.43966 -9.71772,7.55823 c 0,0 6.118566,8.27806 7.558228,8.27806 1.439661,0 17.275945,5.03882 17.275945,5.03882 l 16.556114,10.07763 4.318986,7.91814 4.318987,9.35781 0.719831,4.31898 -0.719831,11.87722 -14.036706,6.47848 -8.278056,-6.83839 -3.599156,-10.79749 -3.959072,-9.35779 -14.756537,-8.99789 -10.797466,-1.79958 -12.237127,-3.23924 -17.2759451,-5.03881 -3.2392398,-11.5173 -7.5582262,-24.83417 -8.2780571,5.03882 V 311.68684 L 222.06788,304.12862 Z",
};

function parsePath(d) {
  // Tokenize: split on commands and whitespace/comma.
  const tokens = [];
  let i = 0;
  const isCmd = (c) => /[A-Za-z]/.test(c);
  const isSep = (c) => /[\s,]/.test(c);
  const isNumStart = (c) => /[0-9.+\-]/.test(c);
  while (i < d.length) {
    const c = d[i];
    if (isSep(c)) { i++; continue; }
    if (isCmd(c)) { tokens.push(c); i++; continue; }
    if (isNumStart(c)) {
      const m = d.slice(i).match(/^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?/);
      if (!m) { i++; continue; }
      tokens.push(parseFloat(m[0]));
      i += m[0].length;
      continue;
    }
    i++;
  }

  const verts = [];
  let cx = 0, cy = 0;
  let startX = 0, startY = 0;
  let cmd = null;
  let ti = 0;
  const next = () => tokens[ti++];

  while (ti < tokens.length) {
    let t = tokens[ti];
    if (typeof t === "string") { cmd = t; ti++; }
    const rel = cmd === cmd.toLowerCase();
    const up = cmd.toUpperCase();

    if (up === "M") {
      const x = next(), y = next();
      if (rel) { cx += x; cy += y; } else { cx = x; cy = y; }
      startX = cx; startY = cy;
      verts.push([cx, cy]);
      cmd = rel ? "l" : "L"; // implicit line-to after M
    } else if (up === "L") {
      const x = next(), y = next();
      if (rel) { cx += x; cy += y; } else { cx = x; cy = y; }
      verts.push([cx, cy]);
    } else if (up === "H") {
      const x = next();
      if (rel) cx += x; else cx = x;
      verts.push([cx, cy]);
    } else if (up === "V") {
      const y = next();
      if (rel) cy += y; else cy = y;
      verts.push([cx, cy]);
    } else if (up === "C") {
      const x1 = next(), y1 = next();
      const x2 = next(), y2 = next();
      const x  = next(), y  = next();
      const sx = cx, sy = cy;
      const cp1x = rel ? sx + x1 : x1, cp1y = rel ? sy + y1 : y1;
      const cp2x = rel ? sx + x2 : x2, cp2y = rel ? sy + y2 : y2;
      const ex   = rel ? sx + x  : x,  ey   = rel ? sy + y  : y;
      for (let k = 1; k <= BEZ_SAMPLES; k++) {
        const tt = k / BEZ_SAMPLES;
        const u = 1 - tt;
        const bx = u*u*u*sx + 3*u*u*tt*cp1x + 3*u*tt*tt*cp2x + tt*tt*tt*ex;
        const by = u*u*u*sy + 3*u*u*tt*cp1y + 3*u*tt*tt*cp2y + tt*tt*tt*ey;
        verts.push([bx, by]);
      }
      cx = ex; cy = ey;
    } else if (up === "Z") {
      cx = startX; cy = startY;
    } else {
      // Unknown command -- skip a single token defensively.
      ti++;
    }
  }
  return verts;
}

function normalize(v) {
  // Map (W, H) viewBox -> [0..1]. Out-of-range values are preserved
  // here; scalePolygon in terrain-shapes.ts already snaps <=0 to 0
  // and >=1 to 1 so anchor vertices land flush on the wall.
  return v.map(([x, y]) => [x / W, y / H]);
}

for (const [name, d] of Object.entries(paths)) {
  const raw = parsePath(d);
  const norm = normalize(raw);
  console.log(`// ${name}: ${norm.length} vertices`);
  console.log(`export const ${name}: NormPolygon = {`);
  console.log(`  points: [`);
  for (const [x, y] of norm) {
    console.log(`    { x: ${x.toFixed(4)}, y: ${y.toFixed(4)} },`);
  }
  console.log(`  ],`);
  console.log(`};`);
  console.log();
}
