import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding";
import { lastEvent, reply, replyImage, type TaskHandler } from "./index.ts";
import {
  extractButtonsTag,
  formatButtonsFallback,
  sendWhatsappImage,
  sendWhatsappInteractiveButtons,
  sendWhatsappMessage,
  transientMetaErrorCode,
  whatsappForBusinessInjectDepsAndRun,
  type WhatsappMessage,
} from "./whatsapp.ts";

const okMessageResponse = (id: string) =>
  new Response(
    JSON.stringify({
      messaging_product: "whatsapp",
      contacts: [{ input: "123", wa_id: "123" }],
      messages: [{ id }],
    }),
    { status: 200 },
  );

const transientMetaErrorResponse = () =>
  new Response(
    JSON.stringify({
      error: {
        message: `(#${transientMetaErrorCode}) Something went wrong`,
        code: transientMetaErrorCode,
        type: "OAuthException",
      },
    }),
    { status: 500 },
  );

Deno.test("sendWhatsappMessage retries transient Meta errors", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = () => {
    attempts++;
    return Promise.resolve(
      attempts < 3
        ? transientMetaErrorResponse()
        : okMessageResponse("sent-id"),
    );
  };

  try {
    const id = await sendWhatsappMessage("token", "from-id")("111")("hello");
    assertEquals(id, "sent-id");
    assertEquals(attempts, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendWhatsappMessage does not retry non-transient errors", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = () => {
    attempts++;
    return Promise.resolve(
      new Response(
        JSON.stringify({ error: { message: "bad request", code: 100 } }),
        { status: 400 },
      ),
    );
  };

  try {
    await assertRejects(() =>
      sendWhatsappMessage("token", "from-id")("111")("hello")
    );
    assertEquals(attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendImage sends link payload with formatted caption", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "image-message-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappImage("token", "from-id")("111");
    const id = await send({
      link: "https://example.com/pic.jpg",
      caption: "<b>Hello</b><br>World",
    });

    assertEquals(id, "image-message-id");
    const { input, init } = calls[0];
    assertEquals(
      input,
      "https://graph.facebook.com/v21.0/from-id/messages",
    );
    const parsed = JSON.parse(String(init?.body ?? ""));
    assertEquals(parsed.recipient_type, "individual");
    assertEquals(parsed.messaging_product, "whatsapp");
    assertEquals(parsed.type, "image");
    assertEquals(parsed.to, "111");
    assertEquals(parsed.image, {
      link: "https://example.com/pic.jpg",
      caption: "*Hello*\nWorld",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendImage supports media id", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "media-id" }],
        }),
        { status: 200 },
      ),
    );

  try {
    const send = sendWhatsappImage("token", "from-id")("222");
    const id = await send({ id: "uploaded-media-id" });
    assertEquals(id, "media-id");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendImage uploads raw data payloads", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const pixelBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";

  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "uploaded-id" }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "image-message-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappImage("token", "from-id")("444");
    const id = await send({
      data: `data:image/png;base64,${pixelBase64}`,
      caption: "<b>Hi</b>",
      filename: "pixel.png",
    });

    assertEquals(id, "image-message-id");
    assertEquals(calls.length, 2);

    const [uploadCall, messageCall] = calls;
    assertEquals(
      uploadCall.input,
      "https://graph.facebook.com/v21.0/from-id/media",
    );

    const uploadBody = uploadCall.init?.body;
    if (!(uploadBody instanceof FormData)) {
      throw new Error("Expected FormData body on media upload");
    }
    assertEquals(uploadBody.get("messaging_product"), "whatsapp");
    assertEquals(uploadBody.get("type"), "image/png");
    const fileEntry = uploadBody.get("file");
    if (!(fileEntry instanceof File)) {
      throw new Error("Expected uploaded file to be a File");
    }
    assertEquals(fileEntry.name, "pixel.png");
    assertEquals(fileEntry.type, "image/png");
    const uploadedBytes = new Uint8Array(await fileEntry.arrayBuffer());
    assertEquals(
      Array.from(uploadedBytes),
      Array.from(decodeBase64(pixelBase64)),
    );

    const parsedMessage = JSON.parse(String(messageCall.init?.body ?? ""));
    assertEquals(parsedMessage.type, "image");
    assertEquals(parsedMessage.image, {
      id: "uploaded-id",
      caption: "*Hi*",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendImage requires link or id", async () => {
  await assertRejects(() =>
    sendWhatsappImage("token", "from")("333")({
      caption: "hi",
    } as unknown as never)
  );
});

Deno.test("replyImage via whatsapp handler sends image", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  const pixelBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    if (calls.length === 1) {
      return Promise.resolve(
        new Response(JSON.stringify({ id: "uploaded-id" }), { status: 200 }),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "reply-image-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  const message: WhatsappMessage = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-id",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            phone_number_id: "from-number-id",
            display_phone_number: "5555",
          },
          contacts: [{ profile: { name: "Tester" }, wa_id: "111" }],
          messages: [{
            from: "111",
            id: "incoming-id",
            timestamp: "0",
            type: "text",
            text: { body: "hello" },
          }],
        },
      }],
    }],
  };

  let sentId: string | undefined;
  const handler: TaskHandler = async () => {
    sentId = await replyImage({
      data: `data:image/png;base64,${pixelBase64}`,
      caption: "<b>Cat</b>",
      filename: "cat.png",
    });
  };

  try {
    await whatsappForBusinessInjectDepsAndRun("token", handler)(message);
    assertEquals(sentId, "reply-image-id");
    assertEquals(calls.length, 2);

    const [uploadCall, messageCall] = calls;
    assertEquals(
      uploadCall.input,
      "https://graph.facebook.com/v21.0/from-number-id/media",
    );

    const uploadBody = uploadCall.init?.body;
    if (!(uploadBody instanceof FormData)) {
      throw new Error("Expected FormData body on media upload");
    }
    const uploadedFile = uploadBody.get("file");
    if (!(uploadedFile instanceof File)) {
      throw new Error("Expected uploaded file to be a File");
    }
    assertEquals(uploadedFile.name, "cat.png");
    assertEquals(uploadBody.get("type"), "image/png");

    assertEquals(
      messageCall.input,
      "https://graph.facebook.com/v21.0/from-number-id/messages",
    );
    const parsed = JSON.parse(String(messageCall.init?.body ?? ""));
    assertEquals(parsed.type, "image");
    assertEquals(parsed.image, {
      id: "uploaded-id",
      caption: "*Cat*",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("inbound image populates attachments array", async () => {
  const originalFetch = globalThis.fetch;
  const pixelBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=";

  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/media-id-123")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            messaging_product: "whatsapp",
            url: "https://example.com/download/image.jpg",
            mime_type: "image/jpeg",
            sha256: "abc123",
            file_size: "1234",
            id: "media-id-123",
          }),
          { status: 200 },
        ),
      );
    }
    if (url.includes("example.com/download/image.jpg")) {
      const bytes = decodeBase64(pixelBase64);
      return Promise.resolve(new Response(bytes, { status: 200 }));
    }
    return Promise.resolve(new Response("", { status: 404 }));
  };

  const message: WhatsappMessage = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-id",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            phone_number_id: "from-number-id",
            display_phone_number: "5555",
          },
          contacts: [{ profile: { name: "Sender" }, wa_id: "111" }],
          messages: [{
            from: "111",
            id: "incoming-image-id",
            timestamp: "0",
            type: "image",
            image: {
              caption: "Check this out",
              id: "media-id-123",
              mime_type: "image/jpeg",
              sha256: "abc123",
            },
          }],
        },
      }],
    }],
  };

  const handler: TaskHandler = () => {
    const event = lastEvent();
    if (event.kind !== "message") throw new Error("expected message event");
    assertEquals(event.text, "Check this out");
    assertEquals(event.attachments?.length, 1);
    assertEquals(event.attachments?.[0].kind, "file");
    assertEquals(event.attachments?.[0].mimeType, "image/jpeg");
    assertEquals(event.attachments?.[0].caption, "Check this out");
    assertEquals(
      event.attachments?.[0].kind === "file"
        ? event.attachments[0].fileUri
        : "",
      "https://example.com/download/image.jpg",
    );
  };

  try {
    await whatsappForBusinessInjectDepsAndRun("token", handler)(message);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("extractButtonsTag extracts buttons and cleans text", () => {
  const result = extractButtonsTag(
    'Would you like weekly event updates?\n<button id="yes">Yes</button>\n<button id="no">No</button>',
  );
  assertEquals(result, {
    remainingText: "Would you like weekly event updates?",
    buttons: [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" },
    ],
  });
});

Deno.test("extractButtonsTag generates id when omitted and handles <buttons> container", () => {
  const result = extractButtonsTag(
    "רוצה לקבל עדכונים?\n<buttons>\n  <button>כן</button>\n  <button>לא</button>\n</buttons>",
  );
  assertEquals(result, {
    remainingText: "רוצה לקבל עדכונים?",
    buttons: [
      { id: "btn_0_כן", title: "כן" },
      { id: "btn_1_לא", title: "לא" },
    ],
  });
});

Deno.test("extractButtonsTag truncates button title to 20 chars and returns null on no buttons", () => {
  assertEquals(extractButtonsTag("Plain text without buttons"), null);
  const result = extractButtonsTag(
    "Choose: <button>Very long button title that exceeds twenty chars</button>",
  );
  assertEquals(result?.buttons[0].title.length, 20);
});

Deno.test("formatButtonsFallback creates readable bracketed choices", () => {
  const text = formatButtonsFallback("Do you want alerts?", [
    { id: "1", title: "Yes" },
    { id: "2", title: "No" },
  ]);
  assertEquals(text, "Do you want alerts?\n\n[Yes]  [No]");
});

Deno.test("sendWhatsappInteractiveButtons posts interactive message payload", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "interactive-btn-msg-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappInteractiveButtons("token", "from-id")("111");
    const id = await send("Would you like updates?", [
      { id: "btn_yes", title: "Yes" },
      { id: "btn_no", title: "No" },
    ]);
    assertEquals(id, "interactive-btn-msg-id");
    assertEquals(calls.length, 1);
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.type, "interactive");
    assertEquals(body.interactive.type, "button");
    assertEquals(body.interactive.body.text, "Would you like updates?");
    assertEquals(body.interactive.action.buttons, [
      { type: "reply", reply: { id: "btn_yes", title: "Yes" } },
      { type: "reply", reply: { id: "btn_no", title: "No" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendWhatsappInteractiveButtons falls back to text when buttons > 3", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "fallback-text-msg-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappInteractiveButtons("token", "from-id")("111");
    const id = await send("Pick one:", ["A", "B", "C", "D"]);
    assertEquals(id, "fallback-text-msg-id");
    assertEquals(calls.length, 1);
    const body = JSON.parse(calls[0].init?.body as string);
    assertEquals(body.type, "text");
    assertEquals(body.text.body, "Pick one:\n\n[A]  [B]  [C]  [D]");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("whatsappForBusinessInjectDepsAndRun sends buttons and handles incoming interactive button reply", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: "outbound-interactive-id" }],
        }),
        { status: 200 },
      ),
    );
  };

  const incomingInteractiveMsg: WhatsappMessage = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-id",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            phone_number_id: "from-number-id",
            display_phone_number: "5555",
          },
          contacts: [{ profile: { name: "Sender" }, wa_id: "111" }],
          messages: [{
            from: "111",
            id: "button-reply-wamid",
            timestamp: "0",
            type: "interactive",
            context: {
              id: "original-question-wamid",
              forwarded: false,
              frequently_forwarded: false,
            },
            interactive: {
              type: "button_reply",
              button_reply: {
                id: "btn_yes",
                title: "כן",
              },
            },
          }],
        },
      }],
    }],
  };

  const handler: TaskHandler = async () => {
    const event = lastEvent();
    if (event.kind !== "message") throw new Error("expected message event");
    assertEquals(event.text, "כן");
    assertEquals(event.referencedMessageId, "original-question-wamid");

    // Test outbound reply with button tags sends interactive message
    await reply(
      'תרצה עוד משהו?\n<button id="more_yes">כן</button>\n<button id="more_no">לא</button>',
    );
  };

  try {
    await whatsappForBusinessInjectDepsAndRun("token", handler)(
      incomingInteractiveMsg,
    );
    assertEquals(calls.length, 1);
    const sentBody = JSON.parse(calls[0].init?.body as string);
    assertEquals(sentBody.type, "interactive");
    assertEquals(sentBody.interactive.type, "button");
    assertEquals(sentBody.interactive.body.text, "תרצה עוד משהו?");
    assertEquals(sentBody.interactive.action.buttons, [
      { type: "reply", reply: { id: "more_yes", title: "כן" } },
      { type: "reply", reply: { id: "more_no", title: "לא" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendWhatsappInteractiveButtons chunks text exceeding 1024 limit across text and interactive messages", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: `msg-${calls.length}` }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappInteractiveButtons("token", "from-id")("111");
    // 1470 characters, matching the length observed in the Agent FOMO incident
    const longText = "A".repeat(800) + "\n\n" + "B".repeat(670);
    const id = await send(longText, ["Choice 1", "Choice 2"]);
    assertEquals(id, "msg-2");
    assertEquals(calls.length, 2);

    const firstMsg = JSON.parse(calls[0].init?.body as string);
    assertEquals(firstMsg.type, "text");
    assertEquals(firstMsg.text.body.length <= 1024, true);
    assertEquals(firstMsg.text.body, "A".repeat(800));

    const secondMsg = JSON.parse(calls[1].init?.body as string);
    assertEquals(secondMsg.type, "interactive");
    assertEquals(secondMsg.interactive.type, "button");
    assertEquals(secondMsg.interactive.body.text.length <= 1024, true);
    assertEquals(secondMsg.interactive.body.text, "B".repeat(670));
    assertEquals(secondMsg.interactive.action.buttons.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendWhatsappMessage chunks text exceeding 4096 limit across multiple text messages", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: `msg-${calls.length}` }],
        }),
        { status: 200 },
      ),
    );
  };

  try {
    const send = sendWhatsappMessage("token", "from-id")("111");
    const longText = "Paragraph 1: " + "X".repeat(3000) + "\n\nParagraph 2: " +
      "Y".repeat(2000);
    const id = await send(longText);
    assertEquals(id, "msg-2");
    assertEquals(calls.length, 2);

    for (const call of calls) {
      const parsed = JSON.parse(call.init?.body as string);
      assertEquals(parsed.type, "text");
      assertEquals(parsed.text.body.length <= 4096, true);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("whatsappForBusinessInjectDepsAndRun delivers reply longer than 1024 cap with buttons across messages", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { input: RequestInfo | URL; init?: RequestInit }[] = [];
  globalThis.fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          messaging_product: "whatsapp",
          contacts: [{ input: "123", wa_id: "123" }],
          messages: [{ id: `outbound-${calls.length}` }],
        }),
        { status: 200 },
      ),
    );
  };

  const incomingMsg: WhatsappMessage = {
    object: "whatsapp_business_account",
    entry: [{
      id: "entry-id",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            phone_number_id: "from-number-id",
            display_phone_number: "5555",
          },
          contacts: [{ profile: { name: "Sender" }, wa_id: "111" }],
          messages: [{
            from: "111",
            id: "user-wamid",
            timestamp: "0",
            type: "text",
            text: { body: "Tell me more" },
          }],
        },
      }],
    }],
  };

  const handler: TaskHandler = async () => {
    // 1470 characters with button tags
    const longReply = "Section 1: " + "A".repeat(800) + "\n\nSection 2: " +
      "B".repeat(600) + '\n<button id="opt_yes">Yes</button>';
    await reply(longReply);
  };

  try {
    await whatsappForBusinessInjectDepsAndRun("token", handler)(incomingMsg);
    assertEquals(calls.length, 2);

    const call1 = JSON.parse(calls[0].init?.body as string);
    assertEquals(call1.type, "text");
    assertEquals(call1.text.body.length <= 1024, true);

    const call2 = JSON.parse(calls[1].init?.body as string);
    assertEquals(call2.type, "interactive");
    assertEquals(call2.interactive.body.text.length <= 1024, true);
    assertEquals(call2.interactive.action.buttons, [
      { type: "reply", reply: { id: "opt_yes", title: "Yes" } },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("sendWhatsappInteractiveButtons uses non-empty text fallback when input text is empty or whitespace", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: url.toString(),
      body: JSON.parse(init?.body as string) as Record<string, unknown>,
    });
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "btn-msg-id" }] }), {
        status: 200,
      }),
    );
  };

  try {
    await sendWhatsappInteractiveButtons("token", "123")("to")("   ", [
      { id: "1", title: "Opt 1" },
    ]);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].body.type, "interactive");
    assertEquals(
      calls[0].body.interactive.body.text,
      "Please select an option:",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
