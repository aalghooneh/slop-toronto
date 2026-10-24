// tools/slim-osm.mjs — trims an Overpass download to what tools/build-geodata.mjs reads: the tags it looks at, no
// bounding boxes, coordinates at 7 decimals (~1 cm)
// usage: node tools/slim-osm.mjs <osm_*.json> [tag,tag,...]
import fs from 'node:fs';

const [file, list] = process.argv.slice(2);
const keep = list ? new Set(list.split(',')) : null;
const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const r7 = (v) => Math.round(v * 1e7) / 1e7;
const geom = (g) => (g || []).map((p) => (p && p.lat !== undefined ? { lat: r7(p.lat), lon: r7(p.lon) } : null));
data.elements = data.elements.map((e) => {
  const out = { type: e.type, id: e.id };
  if (e.lat !== undefined) { out.lat = r7(e.lat); out.lon = r7(e.lon); }
  if (e.nodes) out.nodes = e.nodes;
  if (e.geometry) out.geometry = geom(e.geometry);
  if (e.members) out.members = e.members.map((m) => ({ type: m.type, ref: m.ref, role: m.role, ...(m.geometry ? { geometry: geom(m.geometry) } : {}) }));
  if (e.tags) out.tags = keep ? Object.fromEntries(Object.entries(e.tags).filter(([k]) => keep.has(k))) : e.tags;
  return out;
});
delete data.osm3s;
fs.writeFileSync(file, JSON.stringify(data));
console.log(`${file}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
