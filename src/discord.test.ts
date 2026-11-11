import { assertEquals } from "@std/assert";
import {
  discordApiBaseUrl,
  discordInjectDepsAndRun,
  openDiscordDm,
  sendDiscordMessage,
  splitDiscordMessage,
} from "./discord.ts";
import {
  lastEvent,
  medium,
  messageId,
  reply,
  sendQuotedReply,
  sendReaction,
  type TaskHandler,
  userId,
} from "./index.ts";

Deno.test("splitDiscordMessage splits long messages on newline boundaries under 2000 chars", () => {
  const partA = `${"a".repeat(1500)}\n`;
  const partB = "b".repeat(800);
  const chunks = splitDiscordMessage(`${partA}${partB}`);
  assertEquals(chunks.length, 2);
  assertEquals(chunks[0], "a".repeat(1500));
  assertEquals(chunks[1], partB);
});

Deno.test("sendDiscordMessage posts message and optional reply reference", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "msg_999" }), { status: 200 }),
    );
  };
  const result = await sendDiscordMessage("bot-secret-token")(
    "chan_123",
    "Hello **Discord**",
    "msg_parent_1",
  );
  globalThis.fetch = originalFetch;

  assertEquals(result, "msg_999");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, `${discordApiBaseUrl}/channels/chan_123/messages`);
  assertEquals(
    new Headers(calls[0].init?.headers).get("Authorization"),
    "Bot bot-secret-token",
  );
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    content: "Hello **Discord**",
    message_reference: {
      message_id: "msg_parent_1",
      fail_if_not_exists: false,
    },
  });
});

Deno.test("discordInjectDepsAndRun normalizes message, replies, quotes, reacts, and ignores bots", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "sent_1" }), { status: 200 }),
    );
  };

  const captured: {
    event?: unknown;
    uid?: string;
    med?: string;
    sentId?: string;
    quotedId?: string;
  } = {};

  const handler: TaskHandler = async () => {
    captured.event = lastEvent();
    captured.uid = userId();
    captured.med = medium();
    captured.sentId = await reply("Plain reply");
    captured.quotedId = await sendQuotedReply("Quoted reply", messageId());
    await sendReaction(messageId(), "👍");
  };

  await discordInjectDepsAndRun("bot-token", handler)({
    t: "MESSAGE_CREATE",
    d: {
      id: "m_bot",
      channel_id: "c_1",
      author: { id: "u_bot", username: "otherbot", bot: true },
      content: "ignore me",
      timestamp: "2026-04-01T12:00:00.000Z",
    },
  });
  assertEquals(calls.length, 0);

  await discordInjectDepsAndRun("bot-token", handler)({
    t: "MESSAGE_CREATE",
    d: {
      id: "m_100",
      channel_id: "c_1",
      guild_id: "g_1",
      author: { id: "u_42", username: "alice" },
      content: "hi bot",
      timestamp: "2026-04-01T12:00:00.000Z",
      attachments: [{
        id: "att_1",
        filename: "pic.png",
        content_type: "image/png",
        url: "https://cdn.discordapp.com/attachments/1/2/pic.png",
      }],
    },
  });
  globalThis.fetch = originalFetch;

  assertEquals(captured.uid, "u_42");
  assertEquals(captured.med, "discord");
  assertEquals(captured.sentId, "sent_1");
  assertEquals(captured.quotedId, "sent_1");
  assertEquals(captured.event, {
    kind: "message",
    id: "m_100",
    time: Date.parse("2026-04-01T12:00:00.000Z"),
    text: "hi bot",
    attachments: [{
      kind: "file",
      mimeType: "image/png",
      fileUri: "https://cdn.discordapp.com/attachments/1/2/pic.png",
      caption: "pic.png",
    }],
  });
  assertEquals(calls.length, 3);
  assertEquals(
    calls[2].url,
    `${discordApiBaseUrl}/channels/c_1/messages/m_100/reactions/%F0%9F%91%8D/@me`,
  );
  assertEquals(calls[2].init?.method, "PUT");
});

Deno.test("openDiscordDm creates DM channel for recipient", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) => {
    assertEquals(JSON.parse(String(init?.body)), { recipient_id: "u_99" });
    return Promise.resolve(
      new Response(JSON.stringify({ id: "dm_chan_99" }), { status: 200 }),
    );
  };
  const dmId = await openDiscordDm("bot-token")("u_99");
  globalThis.fetch = originalFetch;
  assertEquals(dmId, "dm_chan_99");
});
