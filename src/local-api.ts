export class LocalApiError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) { super(message); }
}

export async function requestLocal<T>(url: string, fallback: string, options?: RequestInit, request: typeof fetch = fetch): Promise<T> {
  const unavailable = (status?: number) => {
    const reason = options?.signal?.reason;
    return reason?.name === 'AbortError' ? reason : new LocalApiError(reason?.name === 'TimeoutError' ? 'The request timed out.' : fallback, status);
  };
  let response: Response;
  try { response = await request(url, options); }
  catch { throw unavailable(); }
  let value;
  try { value = await response.json(); }
  catch { throw unavailable(response.status); }
  if (!response.ok) {
    const message = typeof value?.error === 'string' && value.error.trim() && value.code !== 'OPERATION_FAILED' ? value.error : fallback;
    throw new LocalApiError(message, response.status, typeof value?.code === 'string' ? value.code : undefined);
  }
  if (value === null || typeof value !== 'object') throw new LocalApiError(fallback, response.status);
  return value as T;
}
