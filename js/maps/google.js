// Google Maps adapter (optional). Currently used for geocoding only – the most accurate
// source for Israeli house numbers, and it stays inside the free monthly cap (10,000).
// To also move route optimization / distances here, implement matrix/fromOrigin with the Routes API.

let loading = null;

function load(key) {
  if (window.google?.maps?.Geocoder) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    window.__smartrunGmapsReady = () => resolve();
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&language=iw&region=IL&loading=async&callback=__smartrunGmapsReady`;
    s.async = true;
    s.onerror = () => { loading = null; reject(new Error('טעינת Google Maps נכשלה')); };
    document.head.append(s);
  });
  return loading;
}

async function geocodeRequest(key, req) {
  await load(key);
  const geocoder = new google.maps.Geocoder();
  const { results } = await geocoder.geocode(req);
  return results;
}

function toResult(r) {
  if (!r) return null;
  const loc = r.geometry.location;
  const exact = ['ROOFTOP', 'RANGE_INTERPOLATED'].includes(r.geometry.location_type) && !r.partial_match;
  return { lat: loc.lat(), lng: loc.lng(), precision: exact ? 'house' : 'street', label: r.formatted_address };
}

export function create(key) {
  return {
    async geocode({ street, houseNo, city }) {
      const results = await geocodeRequest(key, {
        address: `${street} ${houseNo || ''}, ${city}`,
        componentRestrictions: { country: 'IL' },
      });
      return toResult(results[0]);
    },
    async geocodeText(text) {
      const results = await geocodeRequest(key, { address: text, componentRestrictions: { country: 'IL' } });
      return toResult(results[0]);
    },
  };
}
