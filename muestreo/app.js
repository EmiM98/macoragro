/* Muestreo GeoPDF — app de campo para muestras de suelo georreferenciadas */
(function () {
  'use strict';
  const APP_VERSION = '1.0.1';
  const DEPTHS = ['0-20', '20-40', '40-60', '0-60'];
  const ZONE_ORDER = ['MAP', 'AP', 'MP', 'PP', 'BP', 'MBP'];
  const NEAR_M = 25;

  const $ = s => document.querySelector(s);
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v != null) e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
    return e;
  };
  $('#ver').textContent = APP_VERSION;

  // ---------------- IndexedDB ----------------
  let dbp;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('muestreo', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('maps', { keyPath: 'id' });
        d.createObjectStore('samples', { keyPath: 'id' }).createIndex('mapId', 'mapId');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode), s = t.objectStore(store);
      let out; const r = fn(s);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const put = (store, v) => tx(store, 'readwrite', s => s.put(v));
  const getOne = (store, id) => tx(store, 'readonly', s => s.get(id));
  const getAll = store => tx(store, 'readonly', s => s.getAll());
  const del = (store, id) => tx(store, 'readwrite', s => s.delete(id));
  const samplesOf = mapId => tx('samples', 'readonly', s => s.index('mapId').getAll(mapId));

  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  // ---------------- Utilidades ----------------
  let toastT;
  function toast(msg, ms = 2600) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, ms);
  }
  const fmtM = m => (m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km');
  const card = b => ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'][Math.round(b / 45) % 8];
  const fmtCoord = (lat, lon) => lat.toFixed(6) + ', ' + lon.toFixed(6);
  const slug = s => (s || 'lote').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w]+/g, '_').replace(/^_|_$/g, '');
  const pad2 = n => String(n).padStart(2, '0');
  const fmtTime = iso => { const d = new Date(iso); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------------- Carga de un GeoPDF ----------------
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';

  function pickLayers(layers) {
    const pts = layers.filter(l => l.features.every(f => f.type === 'point')).sort((a, b) => b.features.length - a.features.length)[0] || null;
    const zones = layers.filter(l => l.features.filter(f => f.type === 'polygon').length >= 2).sort((a, b) => b.features.length - a.features.length)[0] || null;
    return { pts, zones };
  }

  function labelPoints(layer) {
    if (!layer) return [];
    const keys = ['id', 'ID', 'Id', 'punto', 'PUNTO', 'Punto', 'name', 'Name', 'nombre', 'NOMBRE'];
    let best = null;
    for (const k of keys) {
      const vals = layer.features.map(f => f.props[k]);
      if (vals.every(v => v !== undefined && v !== '') && new Set(vals.map(String)).size === vals.length) { best = k; break; }
    }
    if (!best && layer.features.every(f => f.title) && new Set(layer.features.map(f => f.title)).size === layer.features.length) best = '__title';
    return layer.features.map((f, i) => ({
      label: best === '__title' ? String(f.title) : best ? String(f.props[best]) : String(i + 1),
      lat: f.coords[0], lon: f.coords[1]
    }));
  }

  function zoneColors(zones, georef, ctx, scale, H) {
    const out = {};
    if (!zones) return out;
    zones.features.forEach(f => {
      if (f.type !== 'polygon' || out[f.title]) return;
      const all = f.rings.flat();
      const lats = all.map(p => p[0]), lons = all.map(p => p[1]);
      const [a0, a1, o0, o1] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
      const counts = {};
      for (let k = 0, hits = 0; k < 400 && hits < 25; k++) {
        const lat = a0 + Math.random() * (a1 - a0), lon = o0 + Math.random() * (o1 - o0);
        if (GeoPDF.zoneAt(zones, lat, lon) !== f) continue;
        const [x, y] = GeoPDF.latLonToPage(georef, lat, lon);
        const d = ctx.getImageData(Math.round(x * scale), Math.round((H - y) * scale), 1, 1).data;
        const key = [d[0], d[1], d[2]].map(v => Math.round(v / 16) * 16).join(',');
        counts[key] = (counts[key] || 0) + 1; hits++;
      }
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (top) out[f.title] = 'rgb(' + top[0] + ')';
    });
    return out;
  }

  async function importPdf(file) {
    const loading = $('#loading'); loading.hidden = false;
    $('#loadingText').textContent = 'Leyendo georreferencia…';
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const info = await GeoPDF.read(buf.slice());
      $('#loadingText').textContent = 'Dibujando el mapa…';
      const pdf = await pdfjsLib.getDocument({ data: buf.slice(), isEvalSupported: false }).promise;
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(4, Math.sqrt(14e6 / (base.width * base.height)));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const { pts, zones } = pickLayers(info.layers);
      const colors = zoneColors(zones, info.georef, ctx, scale, info.height);
      const img = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
      canvas.width = canvas.height = 1;
      const rec = {
        id: uid(), name: file.name.replace(/\.pdf$/i, ''), fileName: file.name, created: new Date().toISOString(),
        img, w: info.width, h: info.height, georef: info.georef,
        points: labelPoints(pts), zones: zones ? zones.features.filter(f => f.type === 'polygon').map(f => ({ title: String(f.title || ''), rings: f.rings })) : [],
        zoneColors: colors, prefix: '', lastDepths: ['0-20']
      };
      await put('maps', rec);
      const extra = rec.points.length ? `${rec.points.length} puntos de muestreo` : 'sin puntos de muestreo';
      toast(`Mapa cargado: ${extra}${rec.zones.length ? ' y ' + new Set(rec.zones.map(z => z.title)).size + ' ambientes' : ''}.`, 3500);
      await renderHome();
      openMap(rec.id);
    } catch (e) {
      console.error(e);
      toast(e && e.message && e.message.includes('georreferencia') ? e.message : 'No pude leer ese PDF. ¿Es un GeoPDF exportado desde QGIS?', 4500);
    } finally { loading.hidden = true; }
  }
  $('#pdfInput').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f); });

  // ---------------- Inicio ----------------
  const urls = [];
  async function renderHome() {
    urls.splice(0).forEach(u => URL.revokeObjectURL(u));
    const maps = (await getAll('maps')).sort((a, b) => b.created.localeCompare(a.created));
    const allS = await getAll('samples');
    const list = $('#mapList'); list.textContent = '';
    $('#emptyMaps').hidden = maps.length > 0;
    for (const m of maps) {
      const u = URL.createObjectURL(m.img); urls.push(u);
      const n = allS.filter(s => s.mapId === m.id).length;
      const delBtn = el('button', { class: 'icon-btn small', 'aria-label': 'Borrar lote' });
      delBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      let armed = false;
      delBtn.addEventListener('click', async () => {
        if (!armed) { armed = true; delBtn.classList.add('btn', 'danger'); delBtn.textContent = n ? `¿Borrar con ${n} muestras?` : '¿Borrar?'; setTimeout(() => renderHome(), 4000); return; }
        for (const s of allS.filter(s => s.mapId === m.id)) await del('samples', s.id);
        await del('maps', m.id); renderHome();
      });
      list.append(el('li', { class: 'map-item' },
        el('button', { class: 'open', onclick: () => openMap(m.id) },
          el('img', { src: u, alt: '' }),
          el('div', { class: 'meta' }, el('strong', {}, m.name), el('span', {}, `${n} muestra${n === 1 ? '' : 's'} · ${m.points.length} puntos`))),
        delBtn));
    }
  }

  // ---------------- Mapa ----------------
  let map, cur, overlay, ptLayer, smpLayer, meMarker, accCircle, navLine, target = null, follow = true, showPts = true;
  let fix = null, heading = null, samples = [], wakeLock = null;
  const toLL = (lat, lon) => { const [x, y] = GeoPDF.latLonToPage(cur.georef, lat, lon); return L.latLng(y, x); };
  const zoneHere = (lat, lon) => {
    for (let i = cur.zones.length - 1; i >= 0; i--) if (GeoPDF.inPolygon(cur.zones[i].rings, lat, lon)) return cur.zones[i].title;
    return null;
  };
  const mPerPt = () => {
    const a = GeoPDF.pageToLatLon(cur.georef, cur.w / 2, cur.h / 2), b = GeoPDF.pageToLatLon(cur.georef, cur.w / 2 + 50, cur.h / 2);
    return GeoPDF.distance(a, b) / 50;
  };

  async function openMap(id) {
    cur = await getOne('maps', id);
    if (!cur) return;
    $('#home').hidden = true; $('#mapScreen').hidden = false;
    $('#mapName').textContent = cur.name;
    target = null; follow = true;
    if (!map) {
      map = L.map('map', { crs: L.CRS.Simple, minZoom: -3, maxZoom: 4, zoomSnap: 0.25, zoomDelta: 0.5, attributionControl: false, zoomControl: false, tap: false });
      map.on('dragstart', () => { follow = false; $('#locateBtn').classList.remove('on'); });
    }
    if (overlay) { URL.revokeObjectURL(overlay._url); map.removeLayer(overlay); }
    [ptLayer, smpLayer, meMarker, accCircle, navLine].forEach(l => l && map.removeLayer(l));
    meMarker = accCircle = navLine = null;
    const bounds = L.latLngBounds([0, 0], [cur.h, cur.w]);
    overlay = L.imageOverlay(URL.createObjectURL(cur.img), bounds).addTo(map);
    map.setMaxBounds(bounds.pad(0.5));
    requestAnimationFrame(() => { map.invalidateSize(); map.fitBounds(bounds); });
    ptLayer = L.layerGroup().addTo(map); smpLayer = L.layerGroup().addTo(map);
    showPts = true; $('#layersBtn').classList.remove('on');
    await refreshSamples();
    startGps(); keepAwake();
    updateNav();
  }

  async function refreshSamples() {
    samples = (await samplesOf(cur.id)).sort((a, b) => b.time.localeCompare(a.time));
    const done = new Set(samples.map(s => String(s.point)));
    ptLayer.clearLayers(); smpLayer.clearLayers();
    if (showPts) cur.points.forEach(p => {
      const cls = 'pt' + (done.has(p.label) ? ' done' : '') + (target && target.label === p.label ? ' target' : '');
      L.marker(toLL(p.lat, p.lon), { icon: L.divIcon({ className: '', html: `<div class="${cls}">${esc(p.label)}</div>`, iconSize: [26, 26] }), keyboard: false })
        .on('click', () => setTarget(p)).addTo(ptLayer);
    });
    const seen = new Set();
    samples.forEach(s => {
      const k = s.lat.toFixed(7) + s.lon.toFixed(7); if (seen.has(k)) return; seen.add(k);
      L.marker(toLL(s.lat, s.lon), { icon: L.divIcon({ className: '', html: '<div class="smp"></div>', iconSize: [14, 14] }), keyboard: false, zIndexOffset: 500 })
        .bindPopup(`<b>${esc(s.code)}</b><br>${esc(s.zone || '')} · ${fmtTime(s.time)}`).addTo(smpLayer);
    });
    const total = cur.points.length, hit = cur.points.filter(p => done.has(p.label)).length;
    $('#progress').textContent = total ? `${hit} de ${total} puntos muestreados` : `${samples.length} muestras`;
    $('#count').textContent = samples.length;
  }

  function setTarget(p) {
    target = target && target.label === p.label ? null : p;
    refreshSamples(); updateNav();
  }
  $('#navClose').addEventListener('click', () => { target = null; refreshSamples(); updateNav(); });

  function updateNav() {
    if (navLine) { map.removeLayer(navLine); navLine = null; }
    $('#nav').hidden = !target;
    if (!target) return;
    $('#navTitle').textContent = 'Punto ' + target.label + (zoneHere(target.lat, target.lon) ? ' · ' + zoneHere(target.lat, target.lon) : '');
    if (!fix) { $('#navDist').textContent = 'Esperando GPS…'; return; }
    const here = [fix.lat, fix.lon], there = [target.lat, target.lon];
    const d = GeoPDF.distance(here, there), b = GeoPDF.bearing(here, there);
    $('#navDist').textContent = d < 4 ? '¡Llegaste!' : `${fmtM(d)} al ${card(b)}`;
    $('#navArrow').style.transform = `rotate(${heading == null ? b : b - heading}deg)`;
    navLine = L.polyline([toLL(...here), toLL(...there)], { color: '#1a73e8', weight: 3, dashArray: '6 8', interactive: false }).addTo(map);
  }

  // ---------------- GPS ----------------
  let watchId = null;
  function startGps() {
    if (watchId != null) return;
    if (!('geolocation' in navigator)) { setChip('Sin GPS', 'bad'); return; }
    watchId = navigator.geolocation.watchPosition(onFix, err => {
      setChip(err.code === 1 ? 'GPS bloqueado' : 'Buscando GPS…', err.code === 1 ? 'bad' : 'wait');
      if (err.code === 1) toast('Permití la ubicación: Ajustes › Privacidad › Localización › Safari/Muestreo.', 6000);
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }
  function setChip(t, c) { const g = $('#gpsChip'); g.textContent = t; g.className = 'chip ' + c; }
  function onFix(pos) {
    const c = pos.coords;
    fix = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, alt: c.altitude, t: pos.timestamp };
    setChip('±' + Math.round(c.accuracy) + ' m', c.accuracy <= 5 ? 'good' : c.accuracy <= 15 ? 'fair' : 'bad');
    if (!cur || !map) return;
    const ll = toLL(fix.lat, fix.lon);
    const r = c.accuracy / mPerPt();
    if (!meMarker) {
      accCircle = L.circle(ll, { radius: r, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [20, 20] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(r); }
    const inside = ll.lat >= 0 && ll.lat <= cur.h && ll.lng >= 0 && ll.lng <= cur.w;
    if (follow && inside) map.panTo(ll, { animate: true });
    const z = zoneHere(fix.lat, fix.lon);
    if (inside) $('#hereZone').textContent = z || 'fuera de los ambientes';
    else {
      const center = GeoPDF.pageToLatLon(cur.georef, cur.w / 2, cur.h / 2);
      $('#hereZone').textContent = 'estás fuera del mapa, a ' + fmtM(GeoPDF.distance([fix.lat, fix.lon], center)) + ' del centro';
    }
    updateNav();
  }
  $('#locateBtn').addEventListener('click', () => {
    follow = true; $('#locateBtn').classList.add('on');
    if (fix) map.setView(toLL(fix.lat, fix.lon), Math.max(map.getZoom(), 1.5));
    else toast('Esperando señal GPS…');
  });
  $('#layersBtn').addEventListener('click', () => {
    showPts = !showPts; $('#layersBtn').classList.toggle('on', !showPts);
    refreshSamples(); toast(showPts ? 'Puntos visibles' : 'Puntos ocultos');
  });

  // Brújula (iOS pide permiso)
  function onOrient(e) {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number') h = e.webkitCompassHeading;
    else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
    if (h != null) { heading = h; if (target && fix) $('#navArrow').style.transform = `rotate(${GeoPDF.bearing([fix.lat, fix.lon], [target.lat, target.lon]) - heading}deg)`; }
  }
  let compassOn = false;
  $('#compassBtn').addEventListener('click', async () => {
    if (compassOn) { window.removeEventListener('deviceorientation', onOrient); window.removeEventListener('deviceorientationabsolute', onOrient); compassOn = false; heading = null; $('#compassBtn').classList.remove('on'); updateNav(); toast('Flecha respecto al norte del mapa'); return; }
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
        if (await DeviceOrientationEvent.requestPermission() !== 'granted') { toast('Sin permiso para la brújula'); return; }
      }
      window.addEventListener('deviceorientation', onOrient); window.addEventListener('deviceorientationabsolute', onOrient);
      compassOn = true; $('#compassBtn').classList.add('on'); toast('Brújula activa: la flecha apunta hacia el punto');
    } catch (e) { toast('La brújula no está disponible'); }
  });

  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && cur && !$('#mapScreen').hidden) keepAwake(); });

  $('#backBtn').addEventListener('click', async () => {
    $('#mapScreen').hidden = true; $('#home').hidden = false;
    if (wakeLock) { try { await wakeLock.release(); } catch (e) {} wakeLock = null; }
    renderHome();
  });

  // ---------------- Registrar muestra ----------------
  let formZone = null, formDepths = [];
  function openSheet(id) { $('#sheetBackdrop').hidden = false; $(id).hidden = false; }
  function closeSheets() { $('#sheetBackdrop').hidden = true; $('#sampleSheet').hidden = true; $('#listSheet').hidden = true; }
  $('#sheetBackdrop').addEventListener('click', closeSheets);
  $('#cancelSample').addEventListener('click', closeSheets);

  function chipButtons(container, values, selected, multi, onChange, colors = {}) {
    container.textContent = '';
    values.forEach(v => {
      const b = el('button', { type: 'button', class: 'chip-btn', 'aria-pressed': String(selected.includes(v)) });
      if (colors[v]) b.append(el('span', { class: 'sw', style: 'background:' + colors[v] }));
      b.append(v);
      b.addEventListener('click', () => {
        if (multi) { const i = selected.indexOf(v); i >= 0 ? selected.splice(i, 1) : selected.push(v); }
        else { selected.splice(0, selected.length, ...(selected[0] === v ? [] : [v])); }
        [...container.children].forEach(c => c.setAttribute('aria-pressed', String(selected.includes(c.textContent))));
        onChange && onChange();
      });
      container.append(b);
    });
  }

  function nextExtra() {
    const nums = cur.points.map(p => parseInt(p.label, 10)).concat(samples.map(s => parseInt(s.point, 10))).filter(n => !isNaN(n));
    return String((nums.length ? Math.max(...nums) : 0) + 1);
  }

  $('#sampleBtn').addEventListener('click', () => {
    if (!fix) { toast('Todavía no hay posición GPS. Esperá unos segundos al aire libre.', 3500); return; }
    const here = [fix.lat, fix.lon];
    let near = null, nd = Infinity;
    cur.points.forEach(p => { const d = GeoPDF.distance(here, [p.lat, p.lon]); if (d < nd) { nd = d; near = p; } });
    if (target && GeoPDF.distance(here, [target.lat, target.lon]) <= 2 * NEAR_M) { near = target; nd = GeoPDF.distance(here, [target.lat, target.lon]); }
    const pointLabel = near && nd <= 2 * NEAR_M ? near.label : nextExtra();
    $('#fPoint').value = pointLabel;
    $('#fPrefix').value = cur.prefix || '';
    $('#fObs').value = '';
    $('#formCoords').textContent = `${fmtCoord(fix.lat, fix.lon)} · ±${Math.round(fix.acc)} m` + (near && nd <= 2 * NEAR_M ? ` · a ${fmtM(nd)} del punto ${near.label}` : '');
    const zones = [...new Set(cur.zones.map(z => z.title).filter(Boolean))].sort((a, b) => (ZONE_ORDER.indexOf(a) + 1 || 99) - (ZONE_ORDER.indexOf(b) + 1 || 99));
    const z = zoneHere(fix.lat, fix.lon);
    formZone = z ? [z] : [];
    chipButtons($('#fZones'), zones.length ? zones.concat('Otro') : ['Otro'], formZone, false, null, cur.zoneColors || {});
    formDepths = (cur.lastDepths || ['0-20']).slice();
    chipButtons($('#fDepths'), DEPTHS, formDepths, true, checkWarn);
    checkWarn();
    openSheet('#sampleSheet');
  });
  $('#fPoint').addEventListener('input', checkWarn);

  function checkWarn() {
    const w = [];
    if (fix && fix.acc > 10) w.push(`Precisión baja (±${Math.round(fix.acc)} m). Si podés, esperá a que baje de 10 m.`);
    const dup = samples.filter(s => String(s.point) === $('#fPoint').value.trim() && formDepths.includes(s.depth));
    if (dup.length) w.push(`Ya hay muestra del punto ${$('#fPoint').value.trim()} a ${[...new Set(dup.map(d => d.depth))].join(', ')} cm. Se guarda igual.`);
    $('#formWarn').textContent = w.join(' '); $('#formWarn').hidden = !w.length;
  }

  $('#sampleSheet').addEventListener('submit', async e => {
    e.preventDefault();
    if (!fix) return;
    const point = $('#fPoint').value.trim();
    if (!point) { toast('Poné el número de punto'); return; }
    if (!formDepths.length) { toast('Elegí al menos una profundidad'); return; }
    const prefix = $('#fPrefix').value.trim();
    const time = new Date().toISOString();
    const planned = cur.points.find(p => p.label === point);
    for (const depth of DEPTHS.filter(d => formDepths.includes(d))) {
      await put('samples', {
        id: uid(), mapId: cur.id, prefix, point, code: prefix + point, depth, zone: formZone[0] || '',
        obs: $('#fObs').value.trim(), lat: fix.lat, lon: fix.lon, acc: Math.round(fix.acc * 10) / 10,
        alt: fix.alt == null ? null : Math.round(fix.alt * 10) / 10, time,
        planned: planned ? 'si' : 'no', dist_plan_m: planned ? Math.round(GeoPDF.distance([fix.lat, fix.lon], [planned.lat, planned.lon]) * 10) / 10 : null
      });
    }
    cur.prefix = prefix; cur.lastDepths = formDepths.slice();
    await put('maps', cur);
    closeSheets();
    if (target && target.label === point) target = null;
    await refreshSamples(); updateNav();
    if (navigator.vibrate) navigator.vibrate(60);
    toast(`Guardada ${prefix + point} (${formDepths.length} prof.)`);
  });

  // ---------------- Lista y exportación ----------------
  $('#listBtn').addEventListener('click', () => { renderList(); openSheet('#listSheet'); });
  $('#closeList').addEventListener('click', closeSheets);

  function renderList() {
    const ul = $('#sampleList'); ul.textContent = '';
    $('#emptySamples').hidden = samples.length > 0;
    samples.forEach(s => {
      const go = el('button', { class: 'icon-btn small', 'aria-label': 'Ver en el mapa', onclick: () => { closeSheets(); follow = false; $('#locateBtn').classList.remove('on'); map.setView(toLL(s.lat, s.lon), 2); } });
      go.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6.5-7-11a7 7 0 0114 0c0 4.5-7 11-7 11z"/></svg>';
      const rm = el('button', { class: 'icon-btn small', 'aria-label': 'Borrar muestra' });
      rm.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
      let armed = false;
      rm.addEventListener('click', async () => {
        if (!armed) { armed = true; rm.className = 'btn danger'; rm.textContent = '¿Borrar?'; setTimeout(() => { if (armed) renderList(); }, 3500); return; }
        armed = false; await del('samples', s.id); await refreshSamples(); renderList();
      });
      ul.append(el('li', { class: 'sample-item' },
        el('div', { class: 'meta' },
          el('strong', {}, `${s.code} · ${s.depth} cm`),
          el('span', {}, `${s.zone || 'sin ambiente'} · ${fmtTime(s.time)} · ±${Math.round(s.acc)} m${s.obs ? ' · ' + s.obs : ''}`)),
        el('div', { class: 'acts' }, go, rm)));
    });
  }

  const COLS = ['lote', 'codigo', 'prefijo', 'punto', 'planificado', 'profundidad_cm', 'ambiente', 'lat', 'lon', 'precision_m', 'altitud_m', 'dist_al_punto_m', 'fecha_hora', 'observaciones'];
  const localTime = iso => { const d = new Date(iso); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
  const rowOf = s => [cur.name, s.code, s.prefix, s.point, s.planned, s.depth, s.zone, s.lat.toFixed(7), s.lon.toFixed(7), s.acc, s.alt, s.dist_plan_m, localTime(s.time), s.obs];
  function toCSV(list) {
    const q = v => { v = v == null ? '' : String(v); return /[",;\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return '﻿' + [COLS.join(','), ...list.map(s => rowOf(s).map(q).join(','))].join('\r\n');
  }
  function toGeoJSON(list) {
    return JSON.stringify({ type: 'FeatureCollection', features: list.map(s => {
      const props = {}; COLS.forEach((c, i) => { if (c !== 'lat' && c !== 'lon') props[c] = rowOf(s)[i]; });
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [s.lon, s.lat] }, properties: props };
    }) }, null, 1);
  }
  function toKML(list) {
    const x = v => esc(v == null ? '' : v);
    return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${x(cur.name)} – muestras</name>
<Style id="m"><IconStyle><color>ff3b8a1f</color><scale>1</scale></IconStyle></Style>
${list.map(s => `<Placemark><name>${x(s.code)} ${x(s.depth)}</name><styleUrl>#m</styleUrl><ExtendedData>${COLS.map((c, i) => `<Data name="${c}"><value>${x(rowOf(s)[i])}</value></Data>`).join('')}</ExtendedData><Point><coordinates>${s.lon},${s.lat},0</coordinates></Point></Placemark>`).join('\n')}
</Document></kml>`;
  }
  async function exportAs(kind) {
    if (!samples.length) { toast('No hay muestras para exportar'); return; }
    const list = samples.slice().reverse();
    const d = new Date(), stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    const body = kind === 'csv' ? toCSV(list) : kind === 'kml' ? toKML(list) : toGeoJSON(list);
    const type = kind === 'csv' ? 'text/csv' : kind === 'kml' ? 'application/vnd.google-earth.kml+xml' : 'application/geo+json';
    const name = `${slug(cur.name)}_muestras_${stamp}.${kind}`;
    const file = new File([body], name, { type });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = el('a', { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  document.querySelectorAll('[data-export]').forEach(b => b.addEventListener('click', () => exportAs(b.dataset.export)));

  // Renombrar lote tocando el título
  $('#mapName').addEventListener('click', () => {
    const t = $('#mapName');
    const inp = el('input', { type: 'text', value: cur.name, 'aria-label': 'Nombre del lote', style: 'font:inherit;font-weight:700;border:1px solid var(--line);border-radius:8px;padding:4px 8px;width:100%;background:var(--bg)' });
    t.replaceWith(inp); inp.focus(); inp.select();
    const done = async () => { const v = inp.value.trim(); if (v) { cur.name = v; await put('maps', cur); } t.textContent = cur.name; inp.replaceWith(t); };
    inp.addEventListener('blur', done); inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
  });

  // ---------------- Arranque ----------------
  renderHome();
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__app = { importPdf, openMap, get cur() { return cur; }, onFix, get samples() { return samples; } };
})();
