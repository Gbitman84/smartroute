// Single entry point for all map services. Swap implementations per operation here.
import * as osm from './osm.js';
import * as googleAdapter from './google.js';
import { norm } from '../util.js';

let geocoder = osm;          // 'osm' | 'google'
let onUsage = () => {};

export function configure({ geocoderName = 'osm', googleKey = '', usage } = {}) {
  geocoder = geocoderName === 'google' && googleKey ? googleAdapter.create(googleKey) : osm;
  if (usage) onUsage = usage;
  return geocoder === osm ? 'osm' : 'google';
}

export const geocoderName = () => (geocoder === osm ? 'osm' : 'google');

export async function geocode(addr) {
  const r = await geocoder.geocode(addr);
  if (geocoder !== osm) onUsage('geocode');
  return r;
}

export async function geocodeText(text) {
  const r = await geocoder.geocodeText(text);
  if (geocoder !== osm) onUsage('geocode');
  return r;
}

export const matrix = osm.matrix;
export const fromOrigin = osm.fromOrigin;
export const routeLine = osm.routeLine;
export const streets = osm.streets;

// Substring match anywhere in the name: "רים" → "הנוטרים", "הנו" → "הנוטרים".
export function streetSuggest(list, text, max = 8) {
  const q = norm(text);
  if (!q || !list?.length) return [];
  const starts = [], contains = [];
  for (const name of list) {
    const n = norm(name);
    const i = n.indexOf(q);
    if (i === 0 || n.includes(' ' + q)) starts.push(name);
    else if (i > 0) contains.push(name);
  }
  return starts.concat(contains).slice(0, max);
}
