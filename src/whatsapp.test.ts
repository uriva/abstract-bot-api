import { assertEquals, assertRejects } from "@std/assert";
import { decodeBase64 } from "@std/encoding";
import { replyImage, type TaskHandler } from "./index.ts";
import {
  sendWhatsappImage,
  whatsappForBusinessInjectDepsAndRun,
  type WhatsappMessage,
} from "./whatsapp.ts";

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
      changes: [{
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
