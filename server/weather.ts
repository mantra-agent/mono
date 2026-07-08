const DEFAULT_LAT = 41.8781;
const DEFAULT_LON = -87.6298;
const DEFAULT_LOCATION = "Chicago, IL";

const WMO_CODES: Record<number, string> = {
  0: "Clear sky",
  1: "Mainly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Foggy",
  48: "Depositing rime fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Slight rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Slight snowfall",
  73: "Moderate snowfall",
  75: "Heavy snowfall",
  77: "Snow grains",
  80: "Slight rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Slight snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with slight hail",
  99: "Thunderstorm with heavy hail",
};

function describeWMO(code: number): string {
  return WMO_CODES[code] ?? `Unknown (code ${code})`;
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
  accessedAt: number;
}

class WeatherCache {
  private store = new Map<string, CacheEntry<any>>();
  private maxEntries = 100;

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    entry.accessedAt = Date.now();
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    if (this.store.size >= this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.store) {
        if (v.accessedAt < oldestTime) {
          oldestTime = v.accessedAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.store.delete(oldestKey);
    }
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs, accessedAt: Date.now() });
  }
}

const cache = new WeatherCache();
const CURRENT_TTL = 30 * 60 * 1000;
const FORECAST_TTL = 6 * 60 * 60 * 1000;

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country: string;
  admin1?: string;
}

async function geocodeLocation(query: string): Promise<GeoResult> {
  const cacheKey = `geo:${query.toLowerCase().trim()}`;
  const cached = cache.get<GeoResult>(cacheKey);
  if (cached) return cached;

  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed: ${res.status} ${res.statusText}`);
  const data = await res.json();
  if (!data.results || data.results.length === 0) {
    throw new Error(`Location not found: "${query}"`);
  }
  const r = data.results[0];
  const result: GeoResult = {
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    country: r.country || "",
    admin1: r.admin1,
  };
  cache.set(cacheKey, result, FORECAST_TTL);
  return result;
}

interface ResolvedLocation {
  lat: number;
  lon: number;
  label: string;
}

async function resolveLocation(args: Record<string, any>): Promise<ResolvedLocation> {
  if (args.latitude != null && args.longitude != null) {
    return { lat: Number(args.latitude), lon: Number(args.longitude), label: `${args.latitude}, ${args.longitude}` };
  }
  if (args.location) {
    const geo = await geocodeLocation(String(args.location));
    const label = geo.admin1 ? `${geo.name}, ${geo.admin1}, ${geo.country}` : `${geo.name}, ${geo.country}`;
    return { lat: geo.latitude, lon: geo.longitude, label };
  }
  return { lat: DEFAULT_LAT, lon: DEFAULT_LON, label: DEFAULT_LOCATION };
}

function windDir(deg: number): string {
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

export async function getCurrentWeather(args: Record<string, any>): Promise<string> {
  const loc = await resolveLocation(args);
  const tz = args.timezone || "America/Chicago";
  const cacheKey = `current:${loc.lat},${loc.lon}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m,cloud_cover,surface_pressure&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const c = data.current;

  const lines = [
    `Current weather for ${loc.label}:`,
    `${describeWMO(c.weather_code)}, ${Math.round(c.temperature_2m)}°F (feels like ${Math.round(c.apparent_temperature)}°F)`,
    `Humidity: ${c.relative_humidity_2m}% · Cloud cover: ${c.cloud_cover}%`,
    `Wind: ${Math.round(c.wind_speed_10m)} mph ${windDir(c.wind_direction_10m)}${c.wind_gusts_10m ? ` (gusts ${Math.round(c.wind_gusts_10m)} mph)` : ""}`,
    c.precipitation > 0 ? `Precipitation: ${c.precipitation} in` : null,
  ].filter(Boolean).join("\n");

  cache.set(cacheKey, lines, CURRENT_TTL);
  return lines;
}

export async function getDailyForecast(args: Record<string, any>): Promise<string> {
  const loc = await resolveLocation(args);
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 16);
  const tz = args.timezone || "America/Chicago";
  const cacheKey = `daily:${loc.lat},${loc.lon}:${days}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}&forecast_days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const d = data.daily;

  const header = `${days}-day forecast for ${loc.label}:`;
  const rows: string[] = [];
  for (let i = 0; i < d.time.length; i++) {
    const date = d.time[i];
    const dayName = new Date(date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short" });
    const hi = Math.round(d.temperature_2m_max[i]);
    const lo = Math.round(d.temperature_2m_min[i]);
    const cond = describeWMO(d.weather_code[i]);
    const precip = d.precipitation_probability_max[i];
    const precipAmt = d.precipitation_sum[i];
    const wind = Math.round(d.wind_speed_10m_max[i]);
    const sunrise = d.sunrise[i] ? new Date(d.sunrise[i]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "";
    const sunset = d.sunset[i] ? new Date(d.sunset[i]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }) : "";

    let line = `${dayName} ${date}: ${cond}, ${hi}°/${lo}°F`;
    if (precip > 0) line += ` · ${precip}% chance of precip`;
    if (precipAmt > 0) line += ` (${precipAmt} in)`;
    line += ` · Wind up to ${wind} mph`;
    if (sunrise && sunset) line += ` · ☀ ${sunrise}–${sunset}`;
    rows.push(line);
  }

  const result = [header, ...rows].join("\n");
  cache.set(cacheKey, result, FORECAST_TTL);
  return result;
}

export async function getHourlyForecast(args: Record<string, any>): Promise<string> {
  const loc = await resolveLocation(args);
  const hours = Math.min(Math.max(Number(args.hours) || 24, 1), 168);
  const tz = args.timezone || "America/Chicago";
  const cacheKey = `hourly:${loc.lat},${loc.lon}:${hours}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&hourly=temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}&forecast_hours=${hours}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const h = data.hourly;

  const header = `${hours}-hour forecast for ${loc.label}:`;
  const rows: string[] = [];
  for (let i = 0; i < Math.min(h.time.length, hours); i++) {
    const time = new Date(h.time[i]).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz });
    const date = h.time[i].substring(0, 10);
    const temp = Math.round(h.temperature_2m[i]);
    const feels = Math.round(h.apparent_temperature[i]);
    const cond = describeWMO(h.weather_code[i]);
    const wind = Math.round(h.wind_speed_10m[i]);
    const dir = windDir(h.wind_direction_10m[i]);
    const precipProb = h.precipitation_probability[i];
    const precipAmt = h.precipitation[i];

    let line = `${date} ${time}: ${cond}, ${temp}°F (feels ${feels}°F) · Wind ${wind} mph ${dir}`;
    if (precipProb > 0) line += ` · ${precipProb}% precip`;
    if (precipAmt > 0) line += ` (${precipAmt} in)`;
    rows.push(line);
  }

  const result = [header, ...rows].join("\n");
  cache.set(cacheKey, result, FORECAST_TTL);
  return result;
}

export async function getAlerts(args: Record<string, any>): Promise<string> {
  const loc = await resolveLocation(args);

  const isUS = loc.lat >= 24.396 && loc.lat <= 49.384 && loc.lon >= -125.0 && loc.lon <= -66.934;
  if (!isUS) {
    return `Weather alerts are currently only available for US locations. ${loc.label} appears to be outside the US.`;
  }

  const cacheKey = `alerts:${loc.lat.toFixed(2)},${loc.lon.toFixed(2)}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const pointUrl = `https://api.weather.gov/points/${loc.lat.toFixed(4)},${loc.lon.toFixed(4)}`;
  const pointRes = await fetch(pointUrl, { headers: { "User-Agent": "(mantra-weather, contact@example.com)" } });
  if (!pointRes.ok) {
    return `Unable to fetch NWS data for ${loc.label}. The NWS API may be temporarily unavailable.`;
  }
  const pointData = await pointRes.json();
  const zoneId = pointData.properties?.forecastZone?.split("/").pop();
  if (!zoneId) {
    return `Unable to determine forecast zone for ${loc.label}.`;
  }

  const alertUrl = `https://api.weather.gov/alerts/active?zone=${zoneId}`;
  const alertRes = await fetch(alertUrl, { headers: { "User-Agent": "(mantra-weather, contact@example.com)" } });
  if (!alertRes.ok) {
    return `Unable to fetch alerts for ${loc.label}. The NWS API may be temporarily unavailable.`;
  }
  const alertData = await alertRes.json();
  const features = alertData.features || [];

  if (features.length === 0) {
    const result = `No active weather alerts for ${loc.label}.`;
    cache.set(cacheKey, result, CURRENT_TTL);
    return result;
  }

  const lines = [`Active weather alerts for ${loc.label} (${features.length}):`];
  for (const f of features.slice(0, 10)) {
    const p = f.properties;
    const severity = p.severity || "Unknown";
    const event = p.event || "Alert";
    const headline = p.headline || "";
    const desc = p.description ? p.description.substring(0, 200).replace(/\n/g, " ") : "";
    const expires = p.expires ? new Date(p.expires).toLocaleString("en-US", { timeZone: "America/Chicago" }) : "";

    lines.push(`⚠ [${severity}] ${event}`);
    if (headline) lines.push(`  ${headline}`);
    if (desc) lines.push(`  ${desc}...`);
    if (expires) lines.push(`  Expires: ${expires}`);
    lines.push("");
  }

  const result = lines.join("\n").trim();
  cache.set(cacheKey, result, CURRENT_TTL);
  return result;
}

export async function getHistoricalWeather(args: Record<string, any>): Promise<string> {
  const loc = await resolveLocation(args);
  const tz = args.timezone || "America/Chicago";

  if (!args.startDate) throw new Error("startDate is required for historical weather (format: YYYY-MM-DD)");
  const startDate = String(args.startDate);
  const endDate = String(args.endDate || startDate);

  const cacheKey = `hist:${loc.lat},${loc.lon}:${startDate}:${endDate}`;
  const cached = cache.get<string>(cacheKey);
  if (cached) return cached;

  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${startDate}&end_date=${endDate}&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&timezone=${encodeURIComponent(tz)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo Archive API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  const d = data.daily;

  if (!d || !d.time || d.time.length === 0) {
    return `No historical data available for ${loc.label} on ${startDate}${endDate !== startDate ? ` to ${endDate}` : ""}.`;
  }

  const header = `Historical weather for ${loc.label} (${startDate}${endDate !== startDate ? ` to ${endDate}` : ""}):`;
  const rows: string[] = [];
  for (let i = 0; i < d.time.length; i++) {
    const date = d.time[i];
    const hi = d.temperature_2m_max[i] != null ? Math.round(d.temperature_2m_max[i]) : "N/A";
    const lo = d.temperature_2m_min[i] != null ? Math.round(d.temperature_2m_min[i]) : "N/A";
    const cond = d.weather_code[i] != null ? describeWMO(d.weather_code[i]) : "N/A";
    const precip = d.precipitation_sum[i] ?? 0;
    const wind = d.wind_speed_10m_max[i] != null ? Math.round(d.wind_speed_10m_max[i]) : "N/A";

    let line = `${date}: ${cond}, ${hi}°/${lo}°F`;
    if (precip > 0) line += ` · ${precip} in precip`;
    line += ` · Wind up to ${wind} mph`;
    rows.push(line);
  }

  const result = [header, ...rows].join("\n");
  cache.set(cacheKey, result, FORECAST_TTL);
  return result;
}
