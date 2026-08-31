type WeatherPoint = {
  latitude: number;
  longitude: number;
  temperature: number;
  cloudCover: number;
  windSpeed: number;
};

type AircraftPoint = {
  id: string;
  latitude: number;
  longitude: number;
  altitudeKm: number;
};

type SatellitePoint = AircraftPoint & { name: string };

type CacheEntry<T> = { expiresAt: number; value: T };

let weatherCache: CacheEntry<WeatherPoint[]> | undefined;
let aircraftCache: CacheEntry<AircraftPoint[]> | undefined;
let satelliteCache: CacheEntry<SatellitePoint[]> | undefined;

const WEATHER_TTL = 15 * 60 * 1000;
// Anonymous global OpenSky requests cost four credits; this stays within the
// documented 400-credit daily allowance for a continuously running instance.
const AIRCRAFT_TTL = 15 * 60 * 1000;
const SATELLITE_TTL = 2 * 60 * 60 * 1000;

async function cached<T>(
  entry: CacheEntry<T> | undefined,
  ttl: number,
  load: () => Promise<T>,
  save: (next: CacheEntry<T>) => void,
) {
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  const value = await load();
  save({ value, expiresAt: Date.now() + ttl });
  return value;
}

async function loadWeather() {
  const latitudes = [-70, -50, -30, -10, 10, 30, 50, 70];
  const longitudes = Array.from({ length: 12 }, (_, index) => -165 + index * 30);
  const coordinates = latitudes.flatMap((latitude) =>
    longitudes.map((longitude) => ({ latitude, longitude })),
  );
  const query = new URLSearchParams({
    latitude: coordinates.map(({ latitude }) => latitude).join(','),
    longitude: coordinates.map(({ longitude }) => longitude).join(','),
    current: 'temperature_2m,cloud_cover,wind_speed_10m',
    forecast_days: '1',
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`);
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);
  const payload = (await response.json()) as Array<{
    latitude: number;
    longitude: number;
    current: { temperature_2m: number; cloud_cover: number; wind_speed_10m: number };
  }>;
  return payload.map((item) => ({
    latitude: item.latitude,
    longitude: item.longitude,
    temperature: item.current.temperature_2m,
    cloudCover: item.current.cloud_cover,
    windSpeed: item.current.wind_speed_10m,
  }));
}

async function loadAircraft() {
  const response = await fetch('https://opensky-network.org/api/states/all');
  if (!response.ok) throw new Error(`OpenSky returned ${response.status}`);
  const payload = (await response.json()) as { states?: unknown[][] };
  return (payload.states ?? []).flatMap((state) => {
    const longitude = state[5];
    const latitude = state[6];
    const altitude = state[13] ?? state[7];
    if (typeof latitude !== 'number' || typeof longitude !== 'number') return [];
    return [{
      id: String(state[0]),
      latitude,
      longitude,
      altitudeKm: typeof altitude === 'number' ? Math.max(altitude / 1000, 0) : 0,
    }];
  });
}

type OrbitalElement = {
  NORAD_CAT_ID: string;
  OBJECT_NAME: string;
  EPOCH: string;
  MEAN_MOTION: number;
  ECCENTRICITY: number;
  INCLINATION: number;
  RA_OF_ASC_NODE: number;
  ARG_OF_PERICENTER: number;
  MEAN_ANOMALY: number;
};

function satellitePosition(element: OrbitalElement, now: Date): SatellitePoint | null {
  const meanMotion = Number(element.MEAN_MOTION);
  const eccentricity = Number(element.ECCENTRICITY);
  if (!meanMotion || !Number.isFinite(eccentricity)) return null;

  const radians = Math.PI / 180;
  const elapsedDays = (now.getTime() - new Date(element.EPOCH).getTime()) / 86_400_000;
  const meanAnomaly = (Number(element.MEAN_ANOMALY) * radians + elapsedDays * meanMotion * Math.PI * 2) % (Math.PI * 2);
  let eccentricAnomaly = meanAnomaly;
  for (let iteration = 0; iteration < 6; iteration += 1) {
    eccentricAnomaly = meanAnomaly + eccentricity * Math.sin(eccentricAnomaly);
  }

  const mu = 398600.4418;
  const angularRate = (meanMotion * Math.PI * 2) / 86400;
  const semiMajor = Math.cbrt(mu / (angularRate * angularRate));
  const orbitalX = semiMajor * (Math.cos(eccentricAnomaly) - eccentricity);
  const orbitalY = semiMajor * Math.sqrt(1 - eccentricity * eccentricity) * Math.sin(eccentricAnomaly);
  const inclination = Number(element.INCLINATION) * radians;
  const ascendingNode = Number(element.RA_OF_ASC_NODE) * radians;
  const periapsis = Number(element.ARG_OF_PERICENTER) * radians;
  const x1 = orbitalX * Math.cos(periapsis) - orbitalY * Math.sin(periapsis);
  const y1 = orbitalX * Math.sin(periapsis) + orbitalY * Math.cos(periapsis);
  const x = x1 * Math.cos(ascendingNode) - y1 * Math.cos(inclination) * Math.sin(ascendingNode);
  const y = x1 * Math.sin(ascendingNode) + y1 * Math.cos(inclination) * Math.cos(ascendingNode);
  const z = y1 * Math.sin(inclination);

  const julianDate = now.getTime() / 86_400_000 + 2440587.5;
  const centuries = (julianDate - 2451545) / 36525;
  const siderealDegrees = 280.46061837 + 360.98564736629 * (julianDate - 2451545) + 0.000387933 * centuries * centuries;
  const sidereal = siderealDegrees * radians;
  const earthX = x * Math.cos(sidereal) + y * Math.sin(sidereal);
  const earthY = -x * Math.sin(sidereal) + y * Math.cos(sidereal);
  const radius = Math.sqrt(earthX * earthX + earthY * earthY + z * z);

  return {
    id: String(element.NORAD_CAT_ID),
    name: element.OBJECT_NAME,
    latitude: Math.asin(z / radius) / radians,
    longitude: Math.atan2(earthY, earthX) / radians,
    altitudeKm: Math.max(radius - 6371, 0),
  };
}

async function loadSatellites() {
  const response = await fetch(
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=VISUAL&FORMAT=JSON',
    { headers: { Accept: 'application/json', 'User-Agent': 'earth-sim/0.1' } },
  );
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  const elements = (await response.json()) as OrbitalElement[];
  const now = new Date();
  const stride = Math.max(1, Math.ceil(elements.length / 8_000));
  return elements
    .filter((_, index) => index % stride === 0)
    .map((element) => satellitePosition(element, now))
    .filter((point): point is SatellitePoint => point !== null);
}

async function settle<T>(promise: Promise<T>) {
  try {
    return { data: await promise, error: null };
  } catch (error) {
    return { data: [] as T, error: error instanceof Error ? error.message : 'Source unavailable' };
  }
}

export async function GET() {
  const [weather, aircraft, satellites] = await Promise.all([
    settle(cached(weatherCache, WEATHER_TTL, loadWeather, (next) => { weatherCache = next; })),
    settle(cached(aircraftCache, AIRCRAFT_TTL, loadAircraft, (next) => { aircraftCache = next; })),
    settle(cached(satelliteCache, SATELLITE_TTL, loadSatellites, (next) => { satelliteCache = next; })),
  ]);

  return Response.json(
    { updatedAt: new Date().toISOString(), weather, aircraft, satellites },
    { headers: { 'Cache-Control': 'public, max-age=15, stale-while-revalidate=60' } },
  );
}
