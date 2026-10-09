// api.ts — the dashboard's HTTP client: JSON in and out, one Error whose message comes from the
// body's error field, the raw text or the HTTP status, and the signed-out hook when this
// browser's sign-in has ended. fetch is injected, so tests answer with fakes and a host can
// wrap credentials around it.

/** The slice of `fetch` the client needs: a URL, an init, one Response. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Options of one call: the method (default GET, POST when a body is given) and the JSON body. */
export type ApiOptions = { method?: string | undefined; body?: unknown };

/** An API failure: the usual Error message plus the HTTP status that carried it. */
export type ApiError = Error & { status: number };

/** The typed client every view and store loader goes through. */
export type Api = {
  /** One call to a dashboard path: JSON body in, parsed JSON (or raw text) out. */
  api(path: string, o?: ApiOptions): Promise<unknown>;
  /** A channel operation: POST /api/c/<ch>/op/<name>?as=owner with the args as the body. */
  op(ch: string, name: string, args?: Record<string, unknown>): Promise<unknown>;
  /** The API path of a channel: /api/c/<encoded ch><p>. */
  channelPath(ch: string, p: string): string;
  /** The route of a channel: #/c/<ch><p>, as the address bar spells it. */
  channelHref(ch: string, p: string): string;
};

/** The error message of a failed response: the body's error, the body text, or the status. */
function errorMessage(j: unknown, status: number): string {
  if (j && typeof j === "object") {
    const err = (j as { error?: unknown }).error;
    if (err) return String(err);
  }
  if (typeof j === "string" && j) return j;
  return `HTTP ${status}`;
}

/** Does a parsed body say this browser must sign in again ({signin: true} on a 401)? */
function saysSignIn(j: unknown): boolean {
  return !!j && typeof j === "object" && !!(j as { signin?: unknown }).signin;
}

/** The fetch init of one call: the method (default GET, POST when a body is given) and the
 *  JSON body with its content-type. */
function requestInit(o: ApiOptions): RequestInit {
  const headers: Record<string, string> = {};
  const init: RequestInit = { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers };
  if (o.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(o.body);
  }
  return init;
}

/** Builds the client over one injected fetch; `onSignedOut` replaces core.js's signed-out page. */
export function createApi(fetchFn: FetchFn, onSignedOut: () => void): Api {
  async function api(path: string, o: ApiOptions = {}): Promise<unknown> {
    const r = await fetchFn(path, requestInit(o));
    const ct = r.headers.get("content-type") ?? "";
    const j: unknown = ct.includes("json") ? await r.json().catch(() => null) : await r.text();
    if (r.status === 401 && saysSignIn(j)) onSignedOut();
    if (!r.ok) {
      const e = new Error(errorMessage(j, r.status)) as ApiError;
      e.status = r.status;
      throw e;
    }
    return j;
  }

  return {
    api,
    op: (ch, name, args = {}) => api(`/api/c/${encodeURIComponent(ch)}/op/${name}?as=owner`, { body: args }),
    channelPath: (ch, p) => `/api/c/${encodeURIComponent(ch)}${p}`,
    channelHref: (ch, p) => `#/c/${ch}${p}`,
  };
}
