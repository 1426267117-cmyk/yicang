export async function postLocalConnectorJob({ origin, token, path, body, timeout, request }) {
  let local;
  try { local = new URL(origin); } catch { /* Invalid job origin. */ }
  if (local?.protocol !== 'http:' || local.hostname !== '127.0.0.1'
    || local.username || local.password || local.pathname !== '/' || local.search || local.hash
    || typeof token !== 'string' || token.trim().length < 32) {
    return { error: 'configuration' };
  }
  try {
    const response = await request(new URL(path, local), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    return { status: response.status, result: await response.json().catch(() => null) };
  } catch {
    return { error: 'transport' };
  }
}

export function countOrderJobValue(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
