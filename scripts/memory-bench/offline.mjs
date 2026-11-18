const originalFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const raw = typeof input === 'string' || input instanceof URL ? String(input) : input.url
  const url = new URL(raw)
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1') {
    return await originalFetch(input, init)
  }
  return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } })
}
