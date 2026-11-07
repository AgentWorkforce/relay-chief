import { isIP } from 'node:net';

export function origin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('endpoint_invalid'); }
  const local = url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('endpoint_invalid');
  // Workspace engine port is never an integration endpoint.
  if (local && url.port === '3737') throw new Error('endpoint_reserved');
  return url.origin;
}

/** Bound time and response size. Never expose request data, tokens or provider bodies in errors. */
export async function requestJson(url: URL, init: RequestInit, fetcher: typeof fetch = fetch, timeoutMs = 8000, maxBytes = 1_048_576): Promise<unknown> {
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new Error('http_refused'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('http_empty');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) { await reader.cancel(); throw new Error('http_oversized'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { throw new Error('upstream_unavailable'); }
}
