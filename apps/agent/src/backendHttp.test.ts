import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type net from "node:net";
import { BackendRedirectError, BackendRequestTimeoutError, postBackendJson } from "./backendHttp.js";

async function backend(t: test.TestContext, handler: http.RequestListener) {
  const sockets = new Set<net.Socket>();
  const requestedSockets = new Set<net.Socket>();
  const server = http.createServer(handler);
  server.prependListener("request", request => {
    if (!requestedSockets.has(request.socket)) {
      requestedSockets.add(request.socket);
      request.socket.once("close", () => requestedSockets.delete(request.socket));
    }
  });
  server.keepAliveTimeout = 60_000;
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, requestedSockets };
}

async function noRequestedConnections(sockets: Set<net.Socket>) {
  const deadline = Date.now() + 2_000;
  while (sockets.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  // Some runtimes preconnect a replacement idle socket after aborting. It
  // must not be confused with the socket carrying the rejected response.
  assert.equal(sockets.size, 0, "Rejected responses must release their request-owning connection");
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`HTTP ${status} cancels an unfinished redirect body without following its location`, async t => {
    let targetRequests = 0;
    const service = await backend(t, (request, response) => {
      request.resume();
      if (request.url === "/target") {
        targetRequests++;
        response.end("{}");
        return;
      }
      assert.equal(request.headers.authorization, "Bearer synthetic-test-token");
      response.writeHead(status, { Location: "/target", "Content-Length": "100000000" });
      response.write(Buffer.alloc(64 * 1024, 65)); // Deliberately never end this intermediate response.
    });
    await assert.rejects(postBackendJson(`${service.url}/api/completeScan`, {}, "synthetic-test-token", { timeoutMs: 2_000 }),
      error => error instanceof BackendRedirectError && error.message.includes(String(status)));
    assert.equal(targetRequests, 0);
    await noRequestedConnections(service.requestedSockets);
  });
}

test("JSON requests retain authentication, consume error bodies, and reuse ordinary connections", async t => {
  const received: { payload: unknown; auth?: string; socket: net.Socket }[] = [];
  const text = "synthetic error body ".repeat(8_000);
  const service = await backend(t, (request, response) => {
    let body = "";
    request.on("data", data => { body += data; });
    request.on("end", () => {
      received.push({ payload: JSON.parse(body), auth: request.headers.authorization, socket: request.socket });
      response.writeHead(401, { "Content-Type": "text/plain" });
      response.end(text);
    });
  });
  for (let index = 0; index < 3; index++) {
    const result = await postBackendJson(`${service.url}/api/registerMachine`, { index }, "synthetic-test-token");
    assert.equal(result.response.status, 401);
    assert.equal(result.text, text);
  }
  assert.deepEqual(received.map(item => item.payload), [{ index: 0 }, { index: 1 }, { index: 2 }]);
  assert.ok(received.every(item => item.auth === "Bearer synthetic-test-token"));
  assert.ok(new Set(received.map(item => item.socket)).size < received.length, "Normal calls retain connection pooling");
});

for (const status of [200, 401, 503]) {
  test(`status-only connection checks cancel an unfinished HTTP ${status} body`, async t => {
    const service = await backend(t, (request, response) => {
      request.resume();
      response.writeHead(status, { "Content-Type": "application/json", "Content-Length": "100000000" });
      response.write('{"unfinished":');
    });
    const result = await postBackendJson(`${service.url}/api/registerMachine`, {}, "synthetic-test-token",
      { timeoutMs: 2_000, discardBody: true });
    assert.equal(result.response.status, status);
    assert.equal(result.text, "");
    await noRequestedConnections(service.requestedSockets);
  });
}

for (const status of [200, 307, 401, 503]) {
  test(`HTTP ${status} remains authoritative when its body is already errored`, async t => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("Broken body")); } });
    const response = new Response(body, { status });
    let signal: AbortSignal | undefined;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return response;
    });
    const request = postBackendJson("http://127.0.0.1:9/api/registerMachine", {}, "synthetic-test-token", { discardBody: true });
    if (status === 307) await assert.rejects(request, BackendRedirectError);
    else assert.equal((await request).response.status, status);
    assert.equal(signal?.aborted, true);
  });
}

test("an already-known redirect stays a redirect if cleanup crosses the request deadline", async t => {
  const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise(resolve => setTimeout(resolve, 30)); } });
  t.mock.method(globalThis, "fetch", async () => new Response(body, { status: 307 }));
  await assert.rejects(postBackendJson("http://127.0.0.1:9/api/registerMachine", {}, undefined, { timeoutMs: 10 }), BackendRedirectError);
});

for (const phase of ["headers", "body"] as const) {
  test(`request deadline aborts a stalled response ${phase} and releases its connection`, async t => {
    let requested = false;
    const service = await backend(t, (request, response) => {
      requested = true;
      request.resume();
      if (phase === "body") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"unfinished":');
      }
    });
    await assert.rejects(postBackendJson(`${service.url}/api/uploadBatch`, {}, undefined, { timeoutMs: 200 }),
      error => error instanceof BackendRequestTimeoutError && error.message === "Request timed out after 0.2s");
    assert.equal(requested, true);
    await noRequestedConnections(service.requestedSockets);
  });
}
