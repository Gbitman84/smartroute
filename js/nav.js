// Navigation deep links. The address text always includes the city.
import { fullAddress } from './util.js';

const precise = (d) => d.lat != null && (d.geoStatus === 'ok' || d.geoStatus === 'manual');

export function wazeUrl(d) {
  let url = `https://waze.com/ul?q=${encodeURIComponent(fullAddress(d))}&navigate=yes`;
  if (precise(d)) url += `&ll=${d.lat},${d.lng}`;
  return url;
}

export function gmapsUrl(d) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress(d))}&travelmode=driving`;
}

// Multi-stop Google Maps links: origin = current location, up to 9 waypoints + destination per segment.
export function gmapsSegments(stops, perSegment = 10) {
  const segs = [];
  for (let i = 0; i < stops.length; i += perSegment) {
    const part = stops.slice(i, i + perSegment);
    const dest = part[part.length - 1];
    const wps = part.slice(0, -1).map((d) => fullAddress(d)).join('|');
    let url = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(fullAddress(dest))}&travelmode=driving`;
    if (wps) url += `&waypoints=${encodeURIComponent(wps)}`;
    segs.push({ from: i + 1, to: i + part.length, url });
  }
  return segs;
}
