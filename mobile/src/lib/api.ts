import Config from '../config';

export interface ApiResponse<T> {
  data: T | null;
  status: number;
}

/**
 * Fetch wrapper that prepends Config.SERVER_URL, includes credentials
 * for cookie auth, and handles 401 as a sentinel value.
 */
export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  try {
    await Config.load();
    const res = await fetch(`${Config.SERVER_URL}${path}`, {
      ...init,
      credentials: 'include',
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
