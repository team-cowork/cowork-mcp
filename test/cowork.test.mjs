import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CoworkClient } from "../dist/client.js";
import { createServer } from "../dist/server.js";

const gateway = new URL("https://cowork.example");
const exchangePath = "/api/authorization/auth/agent-tokens/exchange";
const messagesPath = "/api/chat/chat/channels/2/messages";
const fakeAgentToken = "mock-agent-token";
const data = (value, status = 200) => Response.json({ data: value }, { status });
const token = (number) => data({ access_token: `mock-jwt-${number}`, expires_in: 300 });

function mockClient(handler) {
  let now = 0;
  const waits = [];
  const client = new CoworkClient(gateway, fakeAgentToken, handler, async (ms) => {
    waits.push(ms);
    now += ms;
  }, () => now);
  return { client, waits, advance: (ms) => { now += ms; } };
}

async function tools(t, cowork) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(cowork);
  const mcp = new Client({ name: "test", version: "1" });
  t.after(async () => { await mcp.close(); await server.close(); });
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return mcp;
}

const readResult = (result) => JSON.parse(result.content[0].text);

test("JWT exchange is shared by concurrent calls, reused, and refreshed before expiry", async () => {
  let exchanges = 0;
  const bearer = [];
  const { client, advance } = mockClient(async (url, init) => {
    if (url.pathname === exchangePath) {
      const headers = new Headers(init.headers);
      assert.equal(init.method, "POST");
      assert.equal(headers.get("x-cowork-agent-token"), fakeAgentToken);
      assert.equal(headers.has("authorization"), false);
      assert.equal(init.body, undefined);
      return token(++exchanges);
    }
    assert.equal(init.headers.has("x-cowork-agent-token"), false);
    bearer.push(init.headers.get("authorization"));
    return data([]);
  });
  const request = () => client.request("/api/team/teams", "workspace:read");
  await Promise.all([request(), request(), request()]);
  advance(269_000);
  await request();
  advance(1_000);
  await request();
  assert.equal(exchanges, 2);
  assert.deepEqual(bearer, Array(4).fill("Bearer mock-jwt-1").concat("Bearer mock-jwt-2"));
});

test("parallel 401 responses trigger one new exchange", async () => {
  let exchanges = 0;
  const { client } = mockClient(async (url, init) => {
    if (url.pathname === exchangePath) return token(++exchanges);
    return init.headers.get("authorization") === "Bearer mock-jwt-1"
      ? new Response(null, { status: 401 }) : data([]);
  });
  await Promise.all([1, 2, 3].map(() => client.request("/api/team/teams", "workspace:read")));
  assert.equal(exchanges, 2);
});

test("429 uses the six-second exchange default and the API Retry-After date", async () => {
  let exchanges = 0;
  let requests = 0;
  const { client, waits } = mockClient(async (url) => {
    if (url.pathname === exchangePath) {
      if (++exchanges === 1) return new Response(null, { status: 429 });
      return token(1);
    }
    if (++requests === 1) {
      return new Response(null, { status: 429, headers: { "Retry-After": new Date(8_000).toUTCString() } });
    }
    return data([]);
  });
  await client.request("/api/team/teams", "workspace:read");
  assert.deepEqual(waits, [6_000, 2_000]);
  assert.equal(exchanges, 2);
  assert.equal(requests, 2);
});

test("persistent 429 stops after bounded retries", async () => {
  let calls = 0;
  const { client, waits } = mockClient(async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "Retry-After": "3" } });
  });
  await assert.rejects(client.request("/api/team/teams", "workspace:read"), /HTTP 429/);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [3_000, 3_000]);
});

test("Forbidden tool calls report their scope and preserve the cached JWT", async (t) => {
  let exchanges = 0;
  const { client } = mockClient(async (url) => {
    if (url.pathname === exchangePath) return token(++exchanges);
    return new Response("sensitive upstream response", { status: 403 });
  });
  const mcp = await tools(t, client);
  for (const [name, args, scope] of [
    ["list_teams_and_channels", {}, "workspace:read"],
    ["list_threads", { channelId: 2 }, "workspace:read"],
    ["read_thread", { channelId: 2, threadId: 3 }, "chat:read"],
    ["post_thread_message", { channelId: 2, threadId: 3, content: "report", confirmed: true }, "chat:write"],
  ]) {
    const result = await mcp.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    const { error } = readResult(result);
    assert.match(error, new RegExp(scope));
    assert.doesNotMatch(error, /sensitive/);
  }
  assert.equal(exchanges, 1);
});

test("posting requires confirmation and keeps one clientMessageId across retries", async (t) => {
  const posts = [];
  let exchanges = 0;
  const { client, waits } = mockClient(async (url, init) => {
    if (url.pathname === exchangePath) return token(++exchanges);
    assert.equal(url.pathname, messagesPath);
    assert.equal(init.method, "POST");
    posts.push(JSON.parse(init.body));
    if (posts.length === 1) return new Response(null, { status: 401 });
    if (posts.length === 2) return new Response(null, { status: 429, headers: { "Retry-After": "1" } });
    if (posts.length === 3) throw new TypeError("mock dropped connection");
    return data({ queued: true }, 201);
  });
  const mcp = await tools(t, client);
  const name = "post_thread_message";
  const args = { channelId: 2, threadId: 3, content: "report", confirmed: true };
  const unconfirmed = await mcp.callTool({ name, arguments: { ...args, confirmed: false } });
  assert.equal(unconfirmed.isError, true);
  assert.equal(exchanges, 0);
  const accepted = await mcp.callTool({ name, arguments: args });
  const { status, clientMessageId } = readResult(accepted);
  assert.equal(status, "queued");
  assert.match(clientMessageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(posts, Array(4).fill({ threadId: 3, content: "report", type: "TEXT", clientMessageId }));
  assert.deepEqual(waits, [1_000, 1_000]);
  await mcp.callTool({ name, arguments: { ...args, clientMessageId } });
  assert.deepEqual(posts.at(-1), posts[0]);
});

test("built stdio server discovers four tools and uses the gateway lookup and read contract", async (t) => {
  const id = "0123456789abcdef01234567";
  const fileId = "0123456789abcdef01234566";
  const message = { _id: id, channelId: 2, threadId: 3, authorId: 7, type: "TEXT", content: "context", createdAt: "2026-01-01T00:00:00Z" };
  const expected = new Map([
    [exchangePath, { access_token: "mock-jwt", expires_in: 300 }],
    ["/api/team/teams", [{ id: 1, name: "Team" }]],
    ["/api/channel/teams/1/channels", [{ id: 2, name: "backend", type: "TEXT" }, { id: 99, name: "direct", type: "DM" }]],
    ["/api/channel/channels/2/threads?page=0&includeArchived=false", { content: [{ id: 3, name: "Login" }], number: 0, totalPages: 2 }],
    [`${messagesPath}?threadId=3`, [message, { ...message, _id: fileId, type: "FILE", attachments: [{ name: "private" }] }]],
    [`${messagesPath}?threadId=3&before=${fileId}`, []],
  ]);
  const requested = [];
  const http = createHttpServer((request, response) => {
    requested.push(request.url);
    if (!expected.has(request.url)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: expected.get(request.url) }));
  }).listen(0, "127.0.0.1");
  await once(http, "listening");
  const mcp = new Client({ name: "test", version: "1" });
  t.after(async () => {
    await mcp.close();
    await new Promise((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
  });
  await mcp.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { COWORK_API_URL: `http://127.0.0.1:${http.address().port}`, COWORK_AGENT_TOKEN: fakeAgentToken },
  }));
  const { tools: registered } = await mcp.listTools();
  assert.deepEqual(registered.map(({ name }) => name), [
    "list_teams_and_channels", "list_threads", "read_thread", "post_thread_message",
  ]);
  const call = async (name, args) => readResult(await mcp.callTool({ name, arguments: args }));
  assert.deepEqual(await call("list_teams_and_channels", {}), {
    teams: [{ id: 1, name: "Team", channels: [{ id: 2, name: "backend" }] }],
  });
  assert.deepEqual(await call("list_threads", { channelId: 2 }), {
    channelId: 2, threads: [{ id: 3, name: "Login" }], nextPage: 1,
  });
  assert.deepEqual(await call("read_thread", { channelId: 2, threadId: 3 }), {
    channelId: 2, threadId: 3, nextBefore: fileId,
    messages: [{ _id: id, authorId: 7, content: "context", createdAt: message.createdAt }],
  });
  assert.deepEqual(await call("read_thread", { channelId: 2, threadId: 3, before: fileId }), {
    channelId: 2, threadId: 3, nextBefore: null, messages: [],
  });
  assert.deepEqual(requested, [...expected.keys()]);
});
