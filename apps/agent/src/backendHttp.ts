/** Authenticated API calls must go directly to the configured backend. */
export class BackendRedirectError extends Error {
  constructor(status: number) {
    super(`Backend returned a redirect (HTTP ${status}). Use the direct backend URL; API redirects are not supported.`);
    this.name = "BackendRedirectError";
  }
}

export class BackendRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs / 1000}s`);
    this.name = "BackendRequestTimeoutError";
  }
}

async function discardResponseBody(response: Response, controller: AbortController) {
  try {
    await response.body?.cancel();
  } catch {
    // Headers already establish the HTTP result. A broken body must not turn
    // a rejected token or redirect into an offline-connect fallback.
    controller.abort();
  }
}

export async function postBackendJson(
  url: string,
  payload: unknown,
  authToken?: string,
  options: { timeoutMs?: number; discardBody?: boolean } = {},
): Promise<{ response: Response; text: string }> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    const response = await fetch(url, {
      method: "POST", headers, body: JSON.stringify(payload),
      signal: controller.signal, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      // Following a redirect can leave its intermediate streaming body alive
      // after the final response succeeds. Even redirect:"error" can retain
      // that socket in the packaged runtime. Cancel it explicitly before
      // rejecting; never forward the machine token to a redirected endpoint.
      await discardResponseBody(response, controller);
      throw new BackendRedirectError(response.status);
    }
    if (options.discardBody) {
      // Connection checks use the status only. Cancel even a successful body
      // rather than leaving a streaming response attached to the process.
      await discardResponseBody(response, controller);
      return { response, text: "" };
    }
    // Consume every other response, including non-2xx responses. The deadline
    // covers the body as well as waiting for response headers.
    return { response, text: await response.text() };
  } catch (error) {
    controller.abort();
    if (timedOut && !(error instanceof BackendRedirectError)) throw new BackendRequestTimeoutError(timeoutMs);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
