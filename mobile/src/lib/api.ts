import { requestServer } from './network';

export interface ApiResponse<T> {
  data: T | null;
  status: number;
}

/**
 * JSON API adapter over the canonical bounded mobile transport. Authentication
 * remains cookie-owned by the server and iOS shared cookie jar.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  try {
    const res = await requestServer(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

    if (res.status === 401) return { data: null, status: 401 };
    if (!res.ok) return { data: null, status: res.status };

    const data = (await res.json()) as T;
    return { data, status: res.status };
  } catch {
    return { data: null, status: 0 };
  }
}
