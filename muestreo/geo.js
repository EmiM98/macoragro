/* Lectura de GeoPDF (ISO 32000 /VP /Measure GEO) y de las capas vectoriales
   que QGIS/GDAL escriben como contenido marcado (/feature + UserProperties).
   Depende de PDFLib (pdf-lib) como global. */
(function (g) {
  'use strict';

  // ---------- Transformación proyectiva (4 puntos) ----------
  function solve(A, b) {
    const n = b.length;
    for (let i = 0; i < n; i++) {
      let p = i;
      for (let r = i + 1; r < n; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
      if (Math.abs(A[i][i]) < 1e-15) throw new Error('singular');
      for (let r = i + 1; r < n; r++) {
        const f = A[r][i] / A[i][i];
        for (let c = i; c < n; c++) A[r][c] -= f * A[i][c];
        b[r] -= f * b[i];
      }
    }
    const x = new Array(n);
    for (let i = n - 1; i >= 0; i--) {
      let s = b[i];
      for (let c = i + 1; c < n; c++) s -= A[i][c] * x[c];
      x[i] = s / A[i][i];
    }
    return x;
  }
  // H tal que (X,Y) = H(x,y)
  function homography(src, dst) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i], [X, Y] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
      A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
    }
    return solve(A, b).concat(1);
  }
  function applyH(h, x, y) {
    const w = h[6] * x + h[7] * y + h[8];
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  }
  // Ajuste afín por mínimos cuadrados (para 3 puntos o cuando la homografía falla)
  function affine(src, dst) {
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bx = [0, 0, 0], by = [0, 0, 0];
    for (let i = 0; i < src.length; i++) {
      const v = [src[i][0], src[i][1], 1];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) A[r][c] += v[r] * v[c];
        bx[r] += v[r] * dst[i][0]; by[r] += v[r] * dst[i][1];
      }
    }
    const a = solve(A.map(r => r.slice()), bx), c = solve(A.map(r => r.slice()), by);
    return [a[0], a[1], a[2], c[0], c[1], c[2], 0, 0, 1];
  }

  // Construye las funciones página(pt) <-> geográficas(lat,lon)
  function makeGeoref(vp) {
    const [x0, y0, x1, y1] = vp.bbox;
    const page = [], geo = [];
    for (let i = 0; i < vp.lpts.length / 2 && i < vp.gpts.length / 2; i++) {
      page.push([x0 + vp.lpts[2 * i] * (x1 - x0), y0 + vp.lpts[2 * i + 1] * (y1 - y0)]);
      geo.push([vp.gpts[2 * i + 1], vp.gpts[2 * i]]); // (lon, lat)
    }
    let toGeo, toPage;
    try {
      if (page.length < 4) throw 0;
      toGeo = homography(page.slice(0, 4), geo.slice(0, 4));
      toPage = homography(geo.slice(0, 4), page.slice(0, 4));
    } catch (e) {
      toGeo = affine(page, geo); toPage = affine(geo, page);
    }
    return { toGeo, toPage, bbox: vp.bbox };
  }
  function pageToLatLon(gr, x, y) { const [lon, lat] = applyH(gr.toGeo, x, y); return [lat, lon]; }
  function latLonToPage(gr, lat, lon) { return applyH(gr.toPage, lon, lat); }

  // ---------- Tokenizador mínimo de content streams ----------
  function tokenize(s) {
    const out = []; let i = 0; const n = s.length;
    const isWS = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
    const isDelim = c => '()<>[]{}/%'.indexOf(String.fromCharCode(c)) >= 0;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isWS(c)) { i++; continue; }
      const ch = s[i];
      if (ch === '%') { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
      if (ch === '(') { // string
        let d = 1; i++; let st = '';
        while (i < n && d > 0) {
          const k = s[i];
          if (k === '\\') { st += s[i + 1]; i += 2; continue; }
          if (k === '(') d++; else if (k === ')') { d--; if (!d) { i++; break; } }
          st += k; i++;
        }
        out.push({ t: 'str', v: st }); continue;
      }
      if (ch === '<' && s[i + 1] === '<') { out.push({ t: '<<' }); i += 2; continue; }
      if (ch === '>' && s[i + 1] === '>') { out.push({ t: '>>' }); i += 2; continue; }
      if (ch === '<') { const j = s.indexOf('>', i); out.push({ t: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue; }
      if (ch === '[' || ch === ']' || ch === '{' || ch === '}') { out.push({ t: ch }); i++; continue; }
      if (ch === '/') {
        let j = i + 1; while (j < n && !isWS(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
        out.push({ t: 'name', v: s.slice(i + 1, j) }); i = j; continue;
      }
      let j = i; while (j < n && !isWS(s.charCodeAt(j)) && !isDelim(s.charCodeAt(j))) j++;
      if (j === i) { i++; continue; }
      const w = s.slice(i, j); i = j;
      const num = Number(w);
      if (w !== '' && !isNaN(num) && /^[-+.\d]/.test(w)) { out.push({ t: 'num', v: num }); continue; }
      out.push({ t: 'op', v: w });
      if (w === 'ID') { // imagen inline: saltar hasta EI
        const k = s.indexOf('EI', i); i = k < 0 ? n : k + 2;
      }
    }
    return out;
  }

  const mul = (a, b) => [
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5]];
  const tp = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

  // Devuelve { mcid: [subpath, ...] } con coordenadas de página
  function pathsByMcid(text) {
    const toks = tokenize(text);
    const res = {};
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = [];
    const mcStack = []; // mcid o null
    let operands = []; let path = []; let cur = null;
    const curMcid = () => { for (let k = mcStack.length - 1; k >= 0; k--) if (mcStack[k] != null) return mcStack[k]; return null; };
    let i = 0;
    while (i < toks.length) {
      const t = toks[i];
      if (t.t === '<<') { // diccionario inline (propiedades de BDC)
        let d = 1, j = i + 1; const dict = {};
        while (j < toks.length && d > 0) {
          if (toks[j].t === '<<') d++; else if (toks[j].t === '>>') d--;
          else if (d === 1 && toks[j].t === 'name' && toks[j + 1] && toks[j + 1].t === 'num') dict[toks[j].v] = toks[j + 1].v;
          j++;
        }
        operands.push({ t: 'dict', v: dict }); i = j; continue;
      }
      if (t.t !== 'op') { operands.push(t); i++; continue; }
      const op = t.v, nums = operands.filter(o => o.t === 'num').map(o => o.v);
      switch (op) {
        case 'q': stack.push(ctm); break;
        case 'Q': ctm = stack.pop() || [1, 0, 0, 1, 0, 0]; break;
        case 'cm': if (nums.length >= 6) ctm = mul(nums.slice(-6), ctm); break;
        case 'BDC': {
          const d = operands.find(o => o.t === 'dict');
          mcStack.push(d && d.v.MCID != null ? d.v.MCID : null); break;
        }
        case 'BMC': mcStack.push(null); break;
        case 'EMC': mcStack.pop(); break;
        case 'm': cur = [tp(ctm, nums[0], nums[1])]; path.push(cur); break;
        case 'l': if (cur) cur.push(tp(ctm, nums[0], nums[1])); break;
        case 'c': if (cur) cur.push(tp(ctm, nums[4], nums[5])); break;
        case 'v': case 'y': if (cur) cur.push(tp(ctm, nums[2], nums[3])); break;
        case 're': {
          const [x, y, w, h] = nums;
          cur = [tp(ctm, x, y), tp(ctm, x + w, y), tp(ctm, x + w, y + h), tp(ctm, x, y + h), tp(ctm, x, y)];
          path.push(cur); break;
        }
        case 'h': break;
        case 'S': case 's': case 'f': case 'F': case 'f*': case 'B': case 'B*': case 'b': case 'b*': case 'n': {
          const id = curMcid();
          if (id != null && path.length) (res[id] = res[id] || []).push(...path);
          path = []; cur = null; break;
        }
      }
      operands = []; i++;
    }
    return res;
  }

  // ---------- Lectura con pdf-lib ----------
  async function read(bytes) {
    const L = g.PDFLib;
    const { PDFName, PDFArray, PDFDict, PDFNumber, PDFRef, PDFRawStream } = L;
    const doc = await L.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
    const ctx = doc.context;
    const look = o => (o instanceof PDFRef ? ctx.lookup(o) : o);
    const N = s => PDFName.of(s);
    const get = (d, k) => (d && d.get ? look(d.get(N(k))) : undefined);
    const nums = a => (a instanceof PDFArray ? a.asArray().map(x => look(x)).map(x => (x instanceof PDFNumber ? x.asNumber() : Number(x.toString()))) : null);
    const val = v => {
      v = look(v);
      if (!v) return '';
      if (v instanceof PDFNumber) return v.asNumber();
      if (v.decodeText) { try { return v.decodeText(); } catch (e) {} }
      if (v instanceof PDFName) return v.decodeText ? v.decodeText() : v.toString().slice(1);
      return v.toString();
    };

    const pageObj = doc.getPages()[0];
    const page = pageObj.node;
    const media = nums(get(page, 'MediaBox')) || [0, 0, pageObj.getWidth(), pageObj.getHeight()];

    // Viewports georreferenciados
    const vps = [];
    const vpArr = get(page, 'VP');
    if (vpArr instanceof PDFArray) {
      for (const v of vpArr.asArray()) {
        const vd = look(v), m = get(vd, 'Measure');
        if (!m) continue;
        const gpts = nums(get(m, 'GPTS')), lpts = nums(get(m, 'LPTS'));
        if (!gpts || !lpts) continue;
        vps.push({ bbox: nums(get(vd, 'BBox')) || media, gpts, lpts, name: val(get(vd, 'Name')) });
      }
    }
    if (!vps.length) {
      // Algunos GeoPDF ponen /Measure directamente en la página
      const m = get(page, 'Measure');
      if (m) vps.push({ bbox: media, gpts: nums(get(m, 'GPTS')), lpts: nums(get(m, 'LPTS')) });
    }
    if (!vps.length) throw new Error('Este PDF no tiene georreferencia (no encontré /VP /Measure).');
    // el viewport más grande
    vps.sort((a, b) => (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]) - (a.bbox[2] - a.bbox[0]) * (a.bbox[3] - a.bbox[1]));
    const georef = makeGeoref(vps[0]);

    // Capas vectoriales (contenido marcado + árbol de estructura)
    const layers = [];
    try {
      let contents = get(page, 'Contents');
      const streams = contents instanceof PDFArray ? contents.asArray().map(look) : [contents];
      let text = '';
      for (const s of streams) {
        if (!s) continue;
        const data = s instanceof PDFRawStream ? L.decodePDFRawStream(s).decode() : s.getContents();
        let part = ''; for (let k = 0; k < data.length; k += 8192) part += String.fromCharCode.apply(null, data.subarray(k, k + 8192));
        text += part + '\n';
      }
      const geom = pathsByMcid(text);
      const root = get(doc.catalog, 'StructTreeRoot');
      const kids = o => { const k = get(o, 'K'); return k instanceof PDFArray ? k.asArray().map(look) : k ? [k] : []; };
      const props = el => {
        const out = {}; let A = get(el, 'A');
        const As = A instanceof PDFArray ? A.asArray().map(look) : A ? [A] : [];
        for (const a of As) {
          const P = get(a, 'P');
          if (P instanceof PDFArray) for (const p of P.asArray().map(look)) out[val(get(p, 'N'))] = val(get(p, 'V'));
        }
        return out;
      };
      const walk = (el, layerName) => {
        if (!(el instanceof PDFDict)) return;
        const S = val(get(el, 'S')).replace(/^\//, '');
        const T = val(get(el, 'T'));
        if (S === 'Layer') {
          const L2 = { name: T || 'Capa', features: [] }; layers.push(L2);
          kids(el).forEach(k => walk(k, L2));
          return;
        }
        if (S === 'feature' && layerName) {
          const k = get(el, 'K');
          const mcids = (k instanceof PDFArray ? k.asArray().map(look) : [k]).map(x => (x instanceof PDFNumber ? x.asNumber() : x instanceof PDFDict ? val(get(x, 'MCID')) : null)).filter(x => x != null);
          const sub = mcids.flatMap(m => geom[m] || []);
          if (!sub.length) return;
          const f = { title: T, props: props(el) };
          let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
          sub.flat().forEach(([x, y]) => { mnx = Math.min(mnx, x); mny = Math.min(mny, y); mxx = Math.max(mxx, x); mxy = Math.max(mxy, y); });
          const closed = sub.every(r => r.length > 2 && Math.hypot(r[0][0] - r[r.length - 1][0], r[0][1] - r[r.length - 1][1]) < 0.01);
          if (mxx - mnx < 15 && mxy - mny < 15) {
            f.type = 'point'; f.coords = pageToLatLon(georef, (mnx + mxx) / 2, (mny + mxy) / 2);
          } else if (closed) {
            f.type = 'polygon'; f.rings = sub.map(r => r.map(([x, y]) => pageToLatLon(georef, x, y)));
          } else {
            f.type = 'line'; f.rings = sub.map(r => r.map(([x, y]) => pageToLatLon(georef, x, y)));
          }
          layerName.features.push(f);
          return;
        }
        kids(el).forEach(k => walk(k, layerName));
      };
      if (root) kids(root).forEach(k => walk(k, null));
    } catch (e) { console.warn('capas vectoriales', e); }

    return { width: media[2] - media[0], height: media[3] - media[1], georef, layers: layers.filter(l => l.features.length) };
  }

  // Punto en polígono (lat,lon) con regla par-impar sobre todos los anillos
  function inPolygon(rings, lat, lon) {
    let inside = false;
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const [yi, xi] = r[i], [yj, xj] = r[j];
        if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  function distance(a, b) { // metros, haversine
    const R = 6371008.8, r = Math.PI / 180;
    const dLat = (b[0] - a[0]) * r, dLon = (b[1] - a[1]) * r;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function bearing(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
    const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }

  // Ambiente en una posición: el último polígono dibujado queda arriba
  function zoneAt(layer, lat, lon) {
    if (!layer) return null;
    for (let i = layer.features.length - 1; i >= 0; i--) {
      const f = layer.features[i];
      if (f.type === 'polygon' && inPolygon(f.rings, lat, lon)) return f;
    }
    return null;
  }

  g.GeoPDF = { read, zoneAt, pageToLatLon, latLonToPage, inPolygon, distance, bearing, _pathsByMcid: pathsByMcid };
})(typeof window !== 'undefined' ? window : globalThis);
