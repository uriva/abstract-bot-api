import { decodeBase64, encodeBase64 } from "@std/encoding";
import type {
  WebhookMessage,
  WebhookPayload,
} from "@whatsapp-cloudapi/types/webhook";
import {
  anymap,
  coerce,
  empty,
  filter,
  identity,
  join,
  juxtCat,
  map,
  mapCat,
  nonempty,
  pipe,
  replace,
  truncate,
} from "gamla";
import {
  injectBotPhone,
  injectEditMessage,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectReferenceId,
  injectReply,
  injectReplyImage,
  injectSpinner,
  injectTyping,
  injectUserId,
  type MediaAttachment,
} from "./api.ts";
import {
  convertHtmlToFacebookFormat,
  makeHeaders,
  stripUndefined,
} from "./fbUtils.ts";
import type {
  ConversationEvent,
  ImageReplyPayload,
  TaskHandler,
} from "./index.ts";
import type { Endpoint } from "./taskBouncer.ts";

// Custom types for message types not in the library
type ContactsMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "contacts";
  contacts: {
    name: {
      formatted_name: string;
      first_name?: string;
      last_name?: string;
      middle_name?: string;
      suffix?: string;
      prefix?: string;
    };
    phones?: [{
      phone: string;
      wa_id?: string;
      type?: "HOME" | "WORK";
    }];
  }[];
};

type ReactionMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "reaction";
  reaction: { message_id: string; emoji: string };
};

type ExtendedWebhookMessage =
  | WebhookMessage
  | ContactsMessage
  | ReactionMessage;

const apiVersion = "v21.0";

export const convertToWhatsAppFormat = convertHtmlToFacebookFormat;

type SentMessageResponse = {
  messaging_product: "whatsapp";
  contacts: [{ input: string; wa_id: string }];
  messages: [{ id: string }];
};

export const sendWhatsappMessage =
  (accessToken: string, fromNumberId: string) =>
  (to: string): (msg: string) => Promise<string> =>
    pipe(convertToWhatsAppFormat, (body: string) =>
      fetch(
        `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            recipient_type: "individual",
            type: "text",
            messaging_product: "whatsapp",
            to,
            text: { preview_url: false, body },
          }),
          headers: makeHeaders(accessToken),
        },
      ).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as SentMessageResponse;
      }).then(({ messages: [{ id }] }) => id));

type ImageDataPayload = {
  data: string;
  caption?: string;
  mimeType?: string;
  filename?: string;
};

type WhatsappImagePayload = ImageReplyPayload | {
  id: string;
  caption?: string;
};

const defaultMimeType = "image/jpeg";

const extractImageData = (
  payload: ImageDataPayload,
): { blob: Blob; filename: string; mimeType: string } => {
  let { data, mimeType, filename } = payload;
  const dataUrlMatch = data.match(/^data:(.+?);base64,(.+)$/i);
  if (dataUrlMatch) {
    mimeType ??= dataUrlMatch[1];
    data = dataUrlMatch[2];
  }

  const sanitizedBase64 = data.replace(/\s/g, "");
  const bytes = decodeBase64(sanitizedBase64);
  const effectiveMimeType = mimeType ?? defaultMimeType;
  const effectiveFilename = filename ??
    `image.${effectiveMimeType.split("/")[1] ?? "jpg"}`;

  return {
    blob: new Blob([bytes], { type: effectiveMimeType }),
    filename: effectiveFilename,
    mimeType: effectiveMimeType,
  };
};

const uploadImageData = async (
  accessToken: string,
  fromNumberId: string,
  payload: ImageDataPayload,
): Promise<string> => {
  const { blob, filename, mimeType } = extractImageData(payload);
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", blob, filename);
  const response = await fetch(
    `https://graph.facebook.com/${apiVersion}/${fromNumberId}/media`,
    {
      method: "POST",
      body: form,
      headers: { "Authorization": `Bearer ${accessToken}` },
    },
  );
  if (!response.ok) throw new Error(await response.text());
  const { id }: { id: string } = await response.json();
  return id;
};

const imageDescriptorFromPayload = async (
  accessToken: string,
  fromNumberId: string,
  image: WhatsappImagePayload,
) => {
  if ("id" in image) return { id: image.id };
  if ("link" in image) return { link: image.link };
  if ("data" in image) {
    const id = await uploadImageData(accessToken, fromNumberId, image);
    return { id };
  }
  return {};
};

export const sendWhatsappImage =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  async (image: WhatsappImagePayload): Promise<string> => {
    const { caption } = image;
    const imageDescriptor = await imageDescriptorFromPayload(
      accessToken,
      fromNumberId,
      image,
    );

    if (empty(Object.keys(imageDescriptor))) {
      throw new Error("sendWhatsappImage requires an id, link, or data");
    }

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient_type: "individual",
          messaging_product: "whatsapp",
          to,
          type: "image",
          image: stripUndefined({
            ...imageDescriptor,
            caption: caption ? convertToWhatsAppFormat(caption) : undefined,
          }),
        }),
        headers: makeHeaders(accessToken),
      },
    );

    if (!response.ok) throw new Error(await response.text());

    const { messages } = (await response.json()) as SentMessageResponse;
    return messages[0].id;
  };

const templateTextParamConstraints = pipe(
  replace(/\n|\t|(\s\s\s\s)/g, " | "),
  convertToWhatsAppFormat,
  truncate(60),
);

type ParamType = "HEADER" | "BODY" | "FOOTER" | "BUTTONS";
type TemplateTextParam = { type: "text"; text: string };
type TemplateImageParam = { type: "image"; image: { link: string } };
type TemplateParam = TemplateTextParam | TemplateImageParam;
type Component = { type: ParamType; parameters: TemplateParam[] };

export const sendWhatsappTemplate =
  (accessToken: string, fromNumberId: string) =>
  (
    to: string,
    name: string,
    langCode: string,
    components: Component[],
  ): Promise<SentMessageResponse> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient_type: "individual",
          messaging_product: "whatsapp",
          to,
          type: "template",
          template: {
            name,
            language: { code: langCode },
            components: components.map((c) => ({
              ...c,
              parameters: c.parameters.map((p) =>
                p.type === "text"
                  ? ({
                    type: "text",
                    text: templateTextParamConstraints(p.text),
                  })
                  : p
              ),
            })),
          },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as SentMessageResponse;
    });

// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
export type WhatsappMessage = WebhookPayload;

type WebhookVerification = {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
};

const innerMessageTypeEquals = (y: string) => (x: ExtendedWebhookMessage) =>
  "type" in x && x.type === y;

const innerMessages = (msg: WhatsappMessage): ExtendedWebhookMessage[] =>
  msg.entry[0].changes[0].value.messages || [];

const fromNumber = pipe(
  innerMessages,
  (messages: ExtendedWebhookMessage[]) => messages?.[0].from,
);

const messageId = pipe(
  innerMessages,
  (msgs: ExtendedWebhookMessage[]) => msgs[0].id,
);

const referenceId = pipe(
  innerMessages,
  juxtCat(
    pipe(
      filter((msg: ExtendedWebhookMessage) =>
        msg.type === "text" && !!msg.context
      ),
      map((x: ExtendedWebhookMessage) =>
        x.type === "text" && x.context?.id || ""
      ),
    ),
    pipe(
      filter((msg: ExtendedWebhookMessage) => msg.type === "reaction"),
      map((msg: ExtendedWebhookMessage) =>
        msg.type === "reaction" ? msg.reaction.message_id : ""
      ),
    ),
  ),
  ([x]: string[]) => x || "",
);

const messageText = pipe(
  innerMessages,
  map((msg: ExtendedWebhookMessage): string =>
    msg.type === "text"
      ? msg.text.body
      : msg.type === "button"
      ? msg.button.text
      : msg.type === "image"
      ? msg.image.caption ?? ""
      : msg.type === "video"
      ? msg.video.caption ?? ""
      : msg.type === "audio"
      ? ""
      : msg.type === "reaction"
      ? msg.reaction.emoji
      : ""
  ),
  filter((x: string) => x),
  join("\n\n"),
);

const isWelcome = pipe(
  innerMessages,
  anymap(innerMessageTypeEquals("request_welcome")),
);

const toNumberId = (
  { entry: [{ changes: [{ value: { metadata: { phone_number_id } } }] }] }:
    WhatsappMessage,
) => phone_number_id;

const toNumber = (
  { entry: [{ changes: [{ value: { metadata: { display_phone_number } } }] }] }:
    WhatsappMessage,
) => display_phone_number;

export const whatsappWebhookVerificationHandler = (
  verifyToken: string,
  path: string,
): Endpoint<WebhookVerification> => ({
  predicate: ({ url, method }) => url === path && method === "GET",
  bounce: false,
  handler: (msg, res) => {
    if (
      msg["hub.mode"] === "subscribe" && verifyToken === msg["hub.verify_token"]
    ) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(msg["hub.challenge"]);
    } else {
      res.writeHead(404);
      res.end();
    }
  },
});

type MediaGetResponse = {
  messaging_product: "whatsapp";
  url: string;
  mime_type: string;
  sha256: string;
  file_size: string;
  id: string;
};

const getMediaMetaAndData = async (
  accessToken: string,
  id: string,
) => {
  const metaResp = await fetch(
    `https://graph.facebook.com/${apiVersion}/${id}`,
    {
      method: "GET",
      headers: makeHeaders(accessToken),
    },
  );
  if (!metaResp.ok) throw new Error(await metaResp.text());
  const meta: MediaGetResponse = await metaResp.json();
  const fileResp = await fetch(meta.url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!fileResp.ok) throw new Error(await fileResp.text());
  const dataBase64 = encodeBase64(await fileResp.arrayBuffer());
  return { dataBase64, mimeType: meta.mime_type, caption: undefined, ...meta };
};

const messageToAttachements =
  (accessToken: string) =>
  async (m: ExtendedWebhookMessage): Promise<MediaAttachment[]> => {
    if (m.type === "image" && m.image?.id) {
      const meta = await getMediaMetaAndData(accessToken, m.image.id);
      return [{
        kind: "inline",
        mimeType: meta.mimeType,
        dataBase64: meta.dataBase64,
        caption: m.image.caption,
      }];
    } else if (m.type === "video" && m.video?.id) {
      const meta = await getMediaMetaAndData(accessToken, m.video.id);
      return [{
        kind: "inline",
        mimeType: meta.mimeType,
        dataBase64: meta.dataBase64,
        caption: m.video.caption,
      }];
    } else if (m.type === "audio" && m.audio?.id) {
      const meta = await getMediaMetaAndData(accessToken, m.audio.id);
      return [{
        kind: "inline",
        mimeType: meta.mimeType,
        dataBase64: meta.dataBase64,
      }];
    }
    return [];
  };

const getAttachments = (accessToken: string) =>
  pipe(innerMessages, mapCat(messageToAttachements(accessToken)));

const getText = (msg: WhatsappMessage): string =>
  isWelcome(msg) ? "/start" : messageText(msg);

const getContacts = (
  msg: WhatsappMessage,
): Record<string, never> | { contact: { phone: string; name: string } } => {
  const contacts = innerMessages(msg).flatMap((x) =>
    x.type === "contacts" ? x.contacts : []
  );
  if (empty(contacts)) return {};
  const contact = contacts[0];
  const phone = contact.phones?.[0]?.phone;
  const name = contact.name.formatted_name;
  if (!phone) return {};
  return { contact: { phone, name } };
};

const editedMessageId = (msg: WhatsappMessage): string | undefined => {
  const m = innerMessages(msg)[0];
  // deno-lint-ignore no-explicit-any
  if ((m as any)?.context?.id && (m as any)?.edited) {
    // deno-lint-ignore no-explicit-any
    return (m as any).context.id;
  }
  return undefined;
};

const buildWhatsappEvent = async (
  token: string,
  msg: WhatsappMessage,
): Promise<ConversationEvent> => {
  const firstMsg = innerMessages(msg)[0];
  if (firstMsg.type === "reaction") {
    return {
      kind: "reaction",
      reaction: (firstMsg as ReactionMessage).reaction.emoji,
      onMessageId: (firstMsg as ReactionMessage).reaction.message_id,
    };
  }
  const editId = editedMessageId(msg);
  if (editId) {
    return {
      kind: "edit",
      text: getText(msg),
      onMessageId: editId,
      attachments: await getAttachments(token)(msg),
    };
  }
  return {
    kind: "message",
    text: getText(msg),
    attachments: await getAttachments(token)(msg),
    ...getContacts(msg),
  };
};

export const whatsappForBusinessInjectDepsAndRun =
  (token: string, doTask: TaskHandler) =>
  async (msg: WhatsappMessage): Promise<void> => {
    if (!nonempty(innerMessages(msg))) return Promise.resolve();
    const event = await buildWhatsappEvent(token, msg);
    const send = sendWhatsappMessage(token, toNumberId(msg))(fromNumber(msg));
    const sendImageReply = sendWhatsappImage(token, toNumberId(msg))(
      fromNumber(msg),
    );
    return pipe(
      injectLastEvent(() => event),
      injectMedium(() => "whatsapp"),
      injectMessageId(() => messageId(msg)),
      injectBotPhone(() => toNumber(msg)),
      injectUserId(() => coerce(fromNumber(msg))),
      injectSpinner(pipe(send, (_) => () => Promise.resolve())),
      injectReply(send),
      injectReplyImage(sendImageReply),
      injectEditMessage((msgId: string, text: string) =>
        editWhatsappMessage(token, toNumberId(msg))(msgId, text)
      ),
      injectTyping(() =>
        sendWhatsappTypingIndicator(token, toNumberId(msg))(
          messageId(msg),
        ).catch((e) => {
          console.error(e);
        }).then(() => {})
      ),
      referenceId(msg) ? injectReferenceId(() => referenceId(msg)) : identity,
    )(doTask)();
  };

export const whatsappBusinessHandler = (
  token: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<WhatsappMessage> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: whatsappForBusinessInjectDepsAndRun(token, doTask),
});

const editWhatsappMessage =
  (accessToken: string, fromNumberId: string) =>
  (messageId: string, text: string): Promise<void> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`,
      {
        method: "PUT",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          message_id: messageId,
          type: "text",
          text: { body: convertToWhatsAppFormat(text) },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
    });

const sendWhatsappTypingIndicator =
  (accessToken: string, fromNumberId: string) => (messageId: string) =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return response.json();
    });
