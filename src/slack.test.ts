import { assertEquals } from "@std/assert";
import {
  lastEvent,
  messageId,
  reply,
  sendQuotedReply,
  type TaskHandler,
} from "./index.ts";
import { sendSlackMessage, slackInjectDepsAndRun } from "./slack.ts";

Deno.test("sendSlackMessage formats message and thread reply", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, ts: "171234.5678" }), {
        status: 200,
      }),
    );
  };

  try {
    const result = await sendSlackMessage("xoxb-token")(
      "C123",
      "<b>Hello</b><br>World",
      "170000.0001",
    );
    assertEquals(result, "171234.5678");
    assertEquals(calls.length, 1);
    assertEquals(calls[0].input, "https://slack.com/api/chat.postMessage");
    const parsed = JSON.parse(String(calls[0].init?.body ?? ""));
    assertEquals(parsed, {
      channel: "C123",
      text: "*Hello*\nWorld",
      thread_ts: "170000.0001",
      unfurl_links: false,
      unfurl_media: false,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("slackInjectDepsAndRun normalizes inbound message and replies in thread", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, ts: "171234.9999" }), {
        status: 200,
      }),
    );
  };

  let seenEvent;
  let sentId = "";
  let quotedId = "";
  const handler: TaskHandler = async () => {
    seenEvent = lastEvent();
    sentId = await reply("reply text");
    quotedId = await sendQuotedReply("thread text", messageId());
  };

  try {
    await slackInjectDepsAndRun("xoxb-token", handler)({
      type: "event_callback",
      event_id: "Ev123",
      event: {
        type: "message",
        channel: "C123",
        user: "U123",
        text: "hello",
        ts: "170000.0001",
        files: [{
          mimetype: "image/png",
          title: "cat",
          url_private_download: "https://files.example/cat.png",
        }],
      },
    });

    assertEquals(seenEvent, {
      kind: "message",
      text: "hello",
      attachments: [{
        kind: "file",
        mimeType: "image/png",
        fileUri: "https://files.example/cat.png",
        caption: "cat",
      }],
    });
    assertEquals(sentId, "171234.9999");
    assertEquals(quotedId, "171234.9999");
    assertEquals(calls.length, 2);
    const parsedReply = JSON.parse(String(calls[0].init?.body ?? ""));
    assertEquals(parsedReply.thread_ts, undefined);
    const parsedQuotedReply = JSON.parse(String(calls[1].init?.body ?? ""));
    assertEquals(parsedQuotedReply.thread_ts, "170000.0001");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
