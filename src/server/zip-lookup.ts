import type { ZipLookupConfig } from './config.js';

export interface ZipCodePlace {
  city: string;
  state: string;
  latitude?: number;
  longitude?: number;
}

export interface ZipCodeLookup {
  lookup(zipcode: string): Promise<ZipCodePlace | undefined>;
}

interface ZippopotamResponse {
  places?: Array<{
    'place name'?: string;
    'state abbreviation'?: string;
    latitude?: string;
    longitude?: string;
  }>;
}

export class ZippopotamClient implements ZipCodeLookup {
  private readonly places = new Map<string, Promise<ZipCodePlace | undefined>>();

  constructor(
    private readonly config: ZipLookupConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  lookup(zipcode: string): Promise<ZipCodePlace | undefined> {
    const normalized = zipcode.trim().slice(0, 5);
    if (!/^\d{5}$/.test(normalized)) return Promise.resolve(undefined);
    const existing = this.places.get(normalized);
    if (existing) return existing;
    const request = this.fetchPlace(normalized).catch((error) => {
      this.places.delete(normalized);
      throw error;
    });
    this.places.set(normalized, request);
    return request;
  }

  private async fetchPlace(zipcode: string): Promise<ZipCodePlace | undefined> {
    const response = await this.fetchImplementation(`${this.config.apiBaseUrl}/us/${encodeURIComponent(zipcode)}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Zippopotam.us lookup failed with HTTP ${response.status}.`);
    const body = await response.json() as ZippopotamResponse;
    const place = body.places?.[0];
    const city = place?.['place name']?.trim();
    const state = place?.['state abbreviation']?.trim().toUpperCase();
    if (!city || !state || !/^[A-Z]{2}$/.test(state)) return undefined;
    const latitude = parseCoordinate(place?.latitude, -90, 90);
    const longitude = parseCoordinate(place?.longitude, -180, 180);
    return {
      city,
      state,
      ...(latitude !== undefined && longitude !== undefined ? { latitude, longitude } : {}),
    };
  }
}

function parseCoordinate(value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (!value?.trim()) return undefined;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum ? coordinate : undefined;
}
