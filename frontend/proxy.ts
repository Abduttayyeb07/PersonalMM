import { NextRequest, NextResponse } from 'next/server';

// Per-request nonce CSP. Next.js emits inline bootstrap scripts, so a static
// `script-src 'self'` would block hydration. Pages must render dynamically
// (see app/layout.tsx) for the nonce to be applied.
// connect-src is derived from the configured API/socket URLs. With none set the app is same-origin
// ('self'), which is the domain-behind-reverse-proxy layout.
function connectSources(): string {
  const sources = new Set<string>(["'self'"]);
  for (const url of [process.env.NEXT_PUBLIC_API_URL, process.env.NEXT_PUBLIC_WS_URL]) {
    if (!url || url.startsWith('/')) continue;
    try {
      const { origin } = new URL(url);
      sources.add(origin);
      sources.add(origin.replace(/^http/, 'ws'));
    } catch { /* ignore malformed values; 'self' still applies */ }
  }
  return [...sources].join(' ');
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const isDev = process.env.NODE_ENV === 'development';
  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    // Inline style attributes (framer-motion, React style props) cannot carry a nonce.
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `connect-src ${connectSources()}`,
    `object-src 'none'`,
    `frame-ancestors 'none'`,
    `base-uri 'none'`,
    `form-action 'self'`,
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [{
    source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
    missing: [
      { type: 'header', key: 'next-router-prefetch' },
      { type: 'header', key: 'purpose', value: 'prefetch' },
    ],
  }],
};
