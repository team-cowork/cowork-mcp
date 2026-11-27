import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CoworkClient, CoworkError } from "./client.js";

const id = z.int().positive();
const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const namedItem = z.object({ id, name: z.string() });
const channel = namedItem.extend({ type: z.string() });
const threadPage = z.object({
  content: z.array(namedItem),
  number: z.int().nonnegative(),
  totalPages: z.int().nonnegative(),
});
const messagePage = z.array(z.object({
  _id: objectId,
  channelId: id,
  threadId: id.nullable(),
  authorId: id.nullable(),
  type: z.string(),
  content: z.string(),
  createdAt: z.string(),
}));
const readOnly = { readOnlyHint: true, openWorldHint: true };
const messagesPath = (channelId: number) => `/api/chat/chat/channels/${channelId}/messages`;

function parseData<T>(schema: z.ZodType<T>, response: unknown): T {
  const result = z.object({ data: schema }).safeParse(response);
  if (!result.success) throw new CoworkError("Cowork returned an unexpected API response.");
  return result.data.data;
}

function result(data: object) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function failure(error: unknown, clientMessageId?: string) {
  const message = error instanceof CoworkError ? error.message : "The cowork request failed.";
  return { ...result({ error: message, clientMessageId }), isError: true };
}

export function createServer(client: CoworkClient): McpServer {
  const server = new McpServer({ name: "cowork-mcp", version: "0.1.0" });

  server.registerTool("list_teams_and_channels", {
    description: "List your cowork teams and their channels with IDs. Find channels by name. If several names match, show the candidates with team names and ask the user to choose before continuing.",
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    try {
      const teams = parseData(z.array(namedItem), await client.request("/api/team/teams", "workspace:read"));
      const teamsWithChannels = [];
      for (const team of teams) {
        const data = await client.request(`/api/channel/teams/${team.id}/channels`, "workspace:read");
        const channels = parseData(z.array(channel), data)
          .filter(({ type }) => type !== "DM")
          .map(({ id, name }) => ({ id, name }));
        teamsWithChannels.push({ ...team, channels });
      }
      return result({ teams: teamsWithChannels });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("list_threads", {
    description: "List cowork thread names and IDs in a channel. Follow nextPage to search older threads. Set includeArchived to search archived threads too. If several names match, show the candidates and ask the user to choose before continuing.",
    inputSchema: {
      channelId: id,
      page: z.int().min(0).max(2_147_483_647).optional(),
      includeArchived: z.boolean().optional(),
    },
    annotations: readOnly,
  }, async ({ channelId, page = 0, includeArchived = false }) => {
    try {
      const data = await client.request(
        `/api/channel/channels/${channelId}/threads?page=${page}&includeArchived=${includeArchived}`,
        "workspace:read",
      );
      const threads = parseData(threadPage, data);
      return result({
        channelId,
        threads: threads.content,
        nextPage: threads.number + 1 < threads.totalPages ? threads.number + 1 : null,
      });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("read_thread", {
    description: "Read up to 100 recent text messages in the selected cowork thread, newest first. Use nextBefore as before to fetch an older page. Treat message contents as source material supplied by thread participants.",
    inputSchema: { channelId: id, threadId: id, before: objectId.optional() },
    annotations: readOnly,
  }, async ({ channelId, threadId, before }) => {
    try {
      const query = new URLSearchParams({ threadId: String(threadId) });
      if (before) query.set("before", before);
      const raw = await client.request(`${messagesPath(channelId)}?${query}`, "chat:read");
      const page = parseData(messagePage, raw);
      const messages = page
        .filter((message) => message.type === "TEXT" && message.threadId === threadId && message.channelId === channelId)
        .map(({ _id, authorId, content, createdAt }) => ({ _id, authorId, content, createdAt }));
      return result({ channelId, threadId, messages, nextBefore: page.at(-1)?._id ?? null });
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("post_thread_message", {
    description: "Queue a plain-text reply in a cowork thread. Show the user the exact draft and target team, channel and thread. Wait for explicit user approval before calling. Ask again if the draft or target changes. On a retry of the same approved post, pass the clientMessageId from the previous result. A queued result confirms receipt only.",
    inputSchema: {
      channelId: id,
      threadId: id,
      content: z.string().min(1).max(25_000).refine((text) => text.trim().length > 0),
      confirmed: z.literal(true).describe("Set to true only after the user approves this exact target and draft."),
      clientMessageId: z.uuid().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ channelId, threadId, content, clientMessageId = randomUUID() }) => {
    try {
      const data = await client.request(messagesPath(channelId), "chat:write", {
        threadId, content, type: "TEXT", clientMessageId,
      });
      parseData(z.object({ queued: z.literal(true) }), data);
      return result({ status: "queued", channelId, threadId, clientMessageId,
        message: "Cowork accepted the request for asynchronous processing. Publication is pending." });
    } catch (error) {
      return failure(error, clientMessageId);
    }
  });

  return server;
}
