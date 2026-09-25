// The API token, as this browser holds it.
//
// Desktop needs none: the server exempts any request whose Host is loopback, which is
// what the dashboard, the TUI and the CLI all send. A phone arrives through Tailscale
// carrying the machine's own hostname, so it is not exempt, and it pairs once with the
// token the server prints at startup. Everything here is empty on desktop, which is
// what keeps the desktop's requests byte-identical to the ones this app has always
// made.

const KEY = 'ai-code.token';

// A fallback for the browsers where localStorage throws - private mode, storage
// disabled. The token then lives for this page only, which is a worse experience than
// remembering it and a better one than a dashboard that cannot authenticate at all.
let memory = '';

export function getToken() {
  try {
    return localStorage.getItem(KEY) || memory;
  } catch {
    return memory;
  }
}

export function setToken(token) {
  memory = token || '';
  try {
    if (memory) localStorage.setItem(KEY, memory);
    else localStorage.removeItem(KEY);
  } catch {
    // In-memory only.
  }
}

export function clearToken() {
  setToken('');
}

// Headers for `fetch`. An empty object when there is no token, so a request from
// desktop is unchanged.
export function authHeaders() {
  const t = getToken();
  return t ? { authorization: `Bearer ${t}` } : {};
}

// The same token in a query string, for the two transports that cannot set a header:
// EventSource and WebSocket. Every caller here is one of them - the server reads the
// query on any route, but a `fetch` has a header and no reason to use it.
export function withToken(url) {
  const t = getToken();
  if (!t) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`;
}

// Whether this page is on the server's own loopback. The terminal route is
// localhost-only on the server - a paired phone holding a valid token is still refused
// a shell - so a page that is not on localhost has no terminal to offer, and rendering
// the tab anyway would be a tab that can only ever error.
export function onLocalhost() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1';
}

// An event rather than a return value, because a 401 can arrive on any of a dozen
// calls in flight at once and every one of them is answered by the same screen. The
// app listens once and swaps to the pairing view.
export function reportUnauthorized() {
  window.dispatchEvent(new CustomEvent('ai-code:unauthorized'));
}
