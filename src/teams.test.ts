import { assertEquals } from "@std/assert";
import { lastEvent, reply, type TaskHandler } from "./index.ts";
import { sendTeamsMessage, teamsInjectDepsAndRun } from "./teams.ts";

Deno.test("sendTeamsMessage acquires a token and posts markdown text", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "teams-token" }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: "activity-2" }), { status: 200 }),
    );
  };

  try {
    const activityId = await sendTeamsMessage("app-id", "app-password")(
      "https://smba.example/emea/",
      "conversation-1",
      "<b>Hello</b><br>World",
      "incoming-1",
    );
    assertEquals(activityId, "activity-2");
    assertEquals(
      calls[0].input,
      "https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token",
    );
    assertEquals(
      calls[1].input,
      "https://smba.example/emea/v3/conversations/conversation-1/activities",
    );
    const parsed = JSON.parse(String(calls[1].init?.body ?? ""));
    assertEquals(parsed, {
      type: "message",
      text: "*Hello*\nWorld",
      textFormat: "markdown",
      replyToId: "incoming-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("teamsInjectDepsAndRun normalizes inbound messages and replies", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: "teams-token" }), {
          status: 200,
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify({ id: "reply-1" }), { status: 200 }),
    );
  };

  let seenEvent;
  let sentId = "";
  const handler: TaskHandler = async () => {
    seenEvent = lastEvent();
    sentId = await reply("hello back");
  };

  try {
    await teamsInjectDepsAndRun("app-id", "app-password", handler)({
      type: "message",
      id: "incoming-1",
      text: "hello from teams",
      from: { id: "user-1", name: "Ada" },
      recipient: { id: "bot-1", name: "Bot" },
      conversation: { id: "conversation-1" },
      serviceUrl: "https://smba.example/emea/",
      replyToId: "parent-1",
      attachments: [{
        contentType: "image/png",
        contentUrl: "https://files.example/team-image.png",
        name: "diagram",
      }],
    });

    assertEquals(seenEvent, {
      kind: "message",
      text: "hello from teams",
      attachments: [{
        kind: "file",
        mimeType: "image/png",
        fileUri: "https://files.example/team-image.png",
        caption: "diagram",
      }],
      referencedMessageId: "parent-1",
    });
    assertEquals(sentId, "reply-1");
    assertEquals(calls.length, 2);
    const parsed = JSON.parse(String(calls[1].init?.body ?? ""));
    assertEquals(parsed.replyToId, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
