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
  heading: number;
  velocity: number;
  verticalRate: number;
  observedAt: number;
};

type CacheEntry<T> = { expiresAt: number; value: T };

let weatherCache: CacheEntry<WeatherPoint[]> | undefined;
let aircraftCache: CacheEntry<AircraftPoint[]> | undefined;
let satelliteCache: CacheEntry<OrbitalElement[]> | undefined;

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
      heading: typeof state[10] === 'number' ? state[10] : 0,
      velocity: typeof state[9] === 'number' ? state[9] : 0,
      verticalRate: typeof state[11] === 'number' ? state[11] : 0,
      observedAt: typeof state[3] === 'number' ? state[3] : Date.now() / 1000,
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
  EPHEMERIS_TYPE: number;
  CLASSIFICATION_TYPE: string;
  ELEMENT_SET_NO: number;
  REV_AT_EPOCH?: number;
  BSTAR: number;
  MEAN_MOTION_DOT: number;
  MEAN_MOTION_DDOT: number;
};

async function loadSatellites() {
  const response = await fetch(
    'https://celestrak.org/NORAD/elements/gp.php?GROUP=VISUAL&FORMAT=JSON',
    { headers: { Accept: 'application/json', 'User-Agent': 'earth-sim/0.1' } },
  );
  if (!response.ok) throw new Error(`CelesTrak returned ${response.status}`);
  const elements = (await response.json()) as OrbitalElement[];
  return elements;
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
