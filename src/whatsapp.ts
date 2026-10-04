import { decodeBase64 } from "@std/encoding";
import type {
  WebhookMessage,
  WebhookPayload,
} from "@whatsapp-cloudapi/types/webhook";
import {
  anymap,
  coerce,
  conditionalRetry,
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
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectQuotedReply,
  injectReaction,
  injectReferenceId,
  injectReply,
  injectReplyImage,
  injectSpinner,
  injectTyping,
  injectUserId,
  type InteractiveButton,
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
import { extractImgTag, extractVideoTag } from "./telegram.ts";
import { verifyMetaSignature } from "./webhookAuth.ts";

type MessageContext = { id?: string };

// Custom types for message types not in the library
type ContactsMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "contacts";
  context?: MessageContext;
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
  context?: MessageContext;
  reaction: { message_id: string; emoji: string };
};

type LocationMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "location";
  context?: MessageContext;
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
};

type InteractiveReplyMessage = {
  from: string;
  id: string;
  timestamp: string;
  type: "interactive";
  context?: {
    id?: string;
    from?: string;
    forwarded?: boolean;
    frequently_forwarded?: boolean;
  };
  interactive: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
};

type ExtendedWebhookMessage =
  | (WebhookMessage & { context?: MessageContext })
  | ContactsMessage
  | ReactionMessage
  | LocationMessage
  | InteractiveReplyMessage;

const apiVersion = "v21.0";

export const convertToWhatsAppFormat = convertHtmlToFacebookFormat;

type SentMessageResponse = {
  messaging_product: "whatsapp";
  contacts: [{ input: string; wa_id: string }];
  messages: [{ id: string }];
};

// Meta's Cloud API intermittently rejects otherwise-valid sends with a generic
// transient failure (error code 131000, "Something went wrong") or a 5xx. These
// are not caller errors and a plain resend usually succeeds, so retrying them
// prevents a single Meta-side hiccup from surfacing as a user-facing crash.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
export const transientMetaErrorCode = 131000;

export const isTransientMetaError = (status: number, body: string): boolean =>
  status >= 500 || body.includes(`"code":${transientMetaErrorCode}`);

class TransientMetaError extends Error {}

const graphMessagesUrl = (fromNumberId: string) =>
  `https://graph.facebook.com/${apiVersion}/${fromNumberId}/messages`;

const postGraphMessage = conditionalRetry(
  (e: unknown) => e instanceof TransientMetaError,
)(1000, 3, async (
  accessToken: string,
  fromNumberId: string,
  payload: Record<string, unknown>,
): Promise<Response> => {
  const response = await fetch(graphMessagesUrl(fromNumberId), {
    method: "POST",
    body: JSON.stringify(payload),
    headers: makeHeaders(accessToken),
  });
  if (response.ok) return response;
  const body = await response.text();
  if (isTransientMetaError(response.status, body)) {
    throw new TransientMetaError(body);
  }
  throw new Error(body);
});

export const maxWhatsappTextLength = 4096;
export const maxWhatsappInteractiveTextLength = 1024;
export const maxWhatsappCaptionLength = 1024;

export const splitWhatsappText = (
  text: string,
  limit = maxWhatsappTextLength,
): string[] => {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf("\n", limit);
    if (cut <= 0) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
};

const postGraphTextMessage = async (
  accessToken: string,
  fromNumberId: string,
  to: string,
  body: string,
): Promise<string> => {
  const response = await postGraphMessage(accessToken, fromNumberId, {
    recipient_type: "individual",
    type: "text",
    messaging_product: "whatsapp",
    to,
    text: { preview_url: false, body },
  });
  const { messages }: SentMessageResponse = await response.json();
  return messages[0].id;
};

export const sendWhatsappMessage =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  async (msg: string): Promise<string> => {
    const formatted = convertToWhatsAppFormat(msg);
    const chunks = splitWhatsappText(formatted, maxWhatsappTextLength);
    let lastId = "";
    for (const chunk of chunks) {
      lastId = await postGraphTextMessage(accessToken, fromNumberId, to, chunk);
    }
    return lastId;
  };

const isStaleMessageIdError = (text: string): boolean =>
  text.includes('"code":100') && text.includes("does not exist");

export const sendWhatsappQuotedReply =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  async (text: string, replyToMessageId: string): Promise<string> => {
    const body = convertToWhatsAppFormat(text);
    const chunks = splitWhatsappText(body, maxWhatsappTextLength);
    if (empty(chunks)) return "";
    const response = await postGraphMessage(accessToken, fromNumberId, {
      recipient_type: "individual",
      type: "text",
      messaging_product: "whatsapp",
      to,
      text: { preview_url: false, body: chunks[0] },
      context: { message_id: replyToMessageId },
    }).catch((e: unknown) => {
      if (e instanceof Error && isStaleMessageIdError(e.message)) return e;
      throw e;
    });
    if (response instanceof Error) {
      return sendWhatsappMessage(accessToken, fromNumberId)(to)(text);
    }
    const { messages }: SentMessageResponse = await response.json();
    let lastId = messages[0].id;
    for (const chunk of chunks.slice(1)) {
      lastId = await postGraphTextMessage(accessToken, fromNumberId, to, chunk);
    }
    return lastId;
  };

const buttonTagRegex =
  /<button(?:\s+[^>]*\bid=["']([^"']+)["'])?[^>]*>([\s\S]*?)<\/button>|<button(?:\s+[^>]*\bid=["']([^"']+)["'])?[^>]*\btitle=["']([^"']+)["'][^>]*\/?>/gi;

export const extractButtonsTag = (
  text: string,
): { buttons: InteractiveButton[]; remainingText: string } | null => {
  if (!text.toLowerCase().includes("<button")) return null;
  const matches = [...text.matchAll(buttonTagRegex)];
  if (empty(matches)) return null;
  const buttons: InteractiveButton[] = matches.map((match, index) => {
    const id = match[1] || match[3];
    const rawTitle = (match[2] !== undefined ? match[2] : match[4]) || "";
    const title = truncate(20)(rawTitle.replace(/<[^>]+>/g, "").trim());
    const cleanId = truncate(256)(id ? id.trim() : `btn_${index}_${title}`);
    return { id: cleanId, title };
  }).filter(({ title }) => Boolean(title));
  if (empty(buttons)) return null;
  const remainingText = text
    .replace(buttonTagRegex, "")
    .replace(/<\/?(?:buttons|quick_replies)[^>]*>/gi, "")
    .trim();
  return { buttons, remainingText };
};

export const formatButtonsFallback = (
  text: string,
  buttons: InteractiveButton[],
): string => {
  const buttonList = buttons.map(({ title }) => `[${title}]`).join("  ");
  return text ? `${text}\n\n${buttonList}` : buttonList;
};

export const sendWhatsappInteractiveButtons =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  async (
    text: string,
    buttons: (string | InteractiveButton)[],
  ): Promise<string> => {
    const normalizedButtons: InteractiveButton[] = buttons.map(
      (b, idx) => {
        if (typeof b === "string") {
          const title = truncate(20)(b.trim());
          return { id: `btn_${idx}_${title}`, title };
        }
        const title = truncate(20)(b.title.trim());
        const id = truncate(256)((b.id || `btn_${idx}_${title}`).trim());
        return { id, title };
      },
    );

    if (empty(normalizedButtons)) {
      return sendWhatsappMessage(accessToken, fromNumberId)(to)(text);
    }

    if (normalizedButtons.length > 3) {
      return sendWhatsappMessage(accessToken, fromNumberId)(to)(
        formatButtonsFallback(text, normalizedButtons),
      );
    }

    const bodyText = convertToWhatsAppFormat(text.trim() || " ");
    const chunks = splitWhatsappText(
      bodyText,
      maxWhatsappInteractiveTextLength,
    );
    for (const chunk of chunks.slice(0, -1)) {
      await postGraphTextMessage(accessToken, fromNumberId, to, chunk);
    }
    const finalChunk = (chunks[chunks.length - 1] ?? "").trim() || " ";

    const response = await postGraphMessage(accessToken, fromNumberId, {
      recipient_type: "individual",
      type: "interactive",
      messaging_product: "whatsapp",
      to,
      interactive: {
        type: "button",
        body: { text: finalChunk },
        action: {
          buttons: normalizedButtons.map((btn) => ({
            type: "reply",
            reply: {
              id: btn.id,
              title: btn.title,
            },
          })),
        },
      },
    });
    const { messages }: SentMessageResponse = await response.json();
    return messages[0].id;
  };

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

    const formattedCaption = caption
      ? convertToWhatsAppFormat(caption)
      : undefined;
    let initialCaption = formattedCaption;
    let extraChunks: string[] = [];
    if (
      formattedCaption && formattedCaption.length > maxWhatsappCaptionLength
    ) {
      const chunks = splitWhatsappText(
        formattedCaption,
        maxWhatsappCaptionLength,
      );
      initialCaption = chunks[0];
      extraChunks = chunks.slice(1);
    }

    const response = await postGraphMessage(accessToken, fromNumberId, {
      recipient_type: "individual",
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: stripUndefined({
        ...imageDescriptor,
        caption: initialCaption,
      }),
    });

    const { messages } = (await response.json()) as SentMessageResponse;
    let lastId = messages[0].id;
    for (const chunk of extraChunks) {
      lastId = await postGraphTextMessage(accessToken, fromNumberId, to, chunk);
    }
    return lastId;
  };

export const sendWhatsappVideo =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  async (link: string): Promise<string> => {
    const response = await postGraphMessage(accessToken, fromNumberId, {
      recipient_type: "individual",
      messaging_product: "whatsapp",
      to,
      type: "video",
      video: { link },
    });
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
    postGraphMessage(accessToken, fromNumberId, {
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
    }).then((response) => response.json() as Promise<SentMessageResponse>);

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
      filter((msg: ExtendedWebhookMessage) => !!msg.context?.id),
      map((x: ExtendedWebhookMessage) => x.context?.id || ""),
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
      : msg.type === "interactive"
      ? (msg.interactive.button_reply?.title ??
        msg.interactive.list_reply?.title ??
        "")
      : msg.type === "image"
      ? msg.image.caption ?? ""
      : msg.type === "video"
      ? msg.video.caption ?? ""
      : msg.type === "document" && "document" in msg
      ? msg.document.caption ?? ""
      : msg.type === "audio"
      ? ""
      : msg.type === "reaction"
      ? msg.reaction.emoji
      : msg.type === "location"
      ? `https://maps.google.com/maps?q=${msg.location.latitude},${msg.location.longitude}`
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

const getMediaUrlAndMime = async (
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
  return { fileUri: meta.url, mimeType: meta.mime_type };
};

const messageToAttachements =
  (accessToken: string) =>
  async (m: ExtendedWebhookMessage): Promise<MediaAttachment[]> => {
    if (m.type === "image" && m.image?.id) {
      const { fileUri, mimeType } = await getMediaUrlAndMime(
        accessToken,
        m.image.id,
      );
      return [{
        kind: "file",
        mimeType,
        fileUri,
        caption: m.image.caption,
      }];
    } else if (m.type === "video" && m.video?.id) {
      const { fileUri, mimeType } = await getMediaUrlAndMime(
        accessToken,
        m.video.id,
      );
      return [{
        kind: "file",
        mimeType,
        fileUri,
        caption: m.video.caption,
      }];
    } else if (m.type === "document" && "document" in m && m.document?.id) {
      const { fileUri, mimeType } = await getMediaUrlAndMime(
        accessToken,
        m.document.id,
      );
      return [{
        kind: "file",
        mimeType,
        fileUri,
        caption: m.document.caption,
      }];
    } else if (m.type === "audio" && m.audio?.id) {
      const { fileUri, mimeType } = await getMediaUrlAndMime(
        accessToken,
        m.audio.id,
      );
      return [{ kind: "file", mimeType, fileUri }];
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
  const id = messageId(msg);
  if (firstMsg.type === "reaction") {
    return {
      kind: "reaction",
      id,
      reaction: (firstMsg as ReactionMessage).reaction.emoji,
      onMessageId: (firstMsg as ReactionMessage).reaction.message_id,
    };
  }
  const editId = editedMessageId(msg);
  if (editId) {
    return {
      kind: "edit",
      id,
      text: getText(msg),
      onMessageId: editId,
      attachments: await getAttachments(token)(msg),
    };
  }
  const refId = firstMsg.context?.id;
  return {
    kind: "message",
    id,
    time: Number(firstMsg.timestamp) * 1000,
    text: getText(msg),
    attachments: await getAttachments(token)(msg),
    ...getContacts(msg),
    ...(refId ? { referencedMessageId: refId } : {}),
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
    const sendVideoReply = sendWhatsappVideo(token, toNumberId(msg))(
      fromNumber(msg),
    );
    const sendButtons = sendWhatsappInteractiveButtons(token, toNumberId(msg))(
      fromNumber(msg),
    );
    return pipe(
      injectLastEvent(() => event),
      injectMedium(() => "whatsapp"),
      injectMessageId(() => messageId(msg)),
      injectBotPhone(() => toNumber(msg)),
      injectUserId(() => coerce(fromNumber(msg))),
      injectSpinner(pipe(send, (_) => () => Promise.resolve())),
      injectReply(async (t: string) => {
        const extractedVideo = extractVideoTag(t);
        if (extractedVideo) {
          await sendVideoReply(extractedVideo.videoUrl);
          if (!extractedVideo.remainingText) return crypto.randomUUID();
          const buttonsInRemaining = extractButtonsTag(
            extractedVideo.remainingText,
          );
          return buttonsInRemaining && nonempty(buttonsInRemaining.buttons)
            ? sendButtons(
              buttonsInRemaining.remainingText,
              buttonsInRemaining.buttons,
            )
            : send(extractedVideo.remainingText);
        }
        const extracted = extractImgTag(t);
        if (extracted) {
          await sendImageReply({ link: extracted.imageUrl });
          if (!extracted.remainingText) return crypto.randomUUID();
          const buttonsInRemaining = extractButtonsTag(extracted.remainingText);
          return buttonsInRemaining && nonempty(buttonsInRemaining.buttons)
            ? sendButtons(
              buttonsInRemaining.remainingText,
              buttonsInRemaining.buttons,
            )
            : send(extracted.remainingText);
        }
        const extractedButtons = extractButtonsTag(t);
        if (extractedButtons && nonempty(extractedButtons.buttons)) {
          return sendButtons(
            extractedButtons.remainingText,
            extractedButtons.buttons,
          );
        }
        return send(t);
      }),
      injectReplyImage(sendImageReply),
      injectTyping(() =>
        sendWhatsappTypingIndicator(token, toNumberId(msg))(
          messageId(msg),
        ).catch((e) => {
          const text = e instanceof Error ? e.message : String(e);
          if (!isStaleMessageIdError(text)) console.error(e);
        }).then(() => {})
      ),
      injectReaction((msgId: string, emoji: string) =>
        fetch(
          `https://graph.facebook.com/${apiVersion}/${
            toNumberId(msg)
          }/messages`,
          {
            method: "POST",
            body: JSON.stringify({
              messaging_product: "whatsapp",
              recipient_type: "individual",
              to: fromNumber(msg),
              type: "reaction",
              reaction: { message_id: msgId, emoji },
            }),
            headers: makeHeaders(token),
          },
        ).then(async (response) => {
          if (!response.ok) {
            const errText = await response.text();
            if (!isStaleMessageIdError(errText)) {
              console.error("WhatsApp reaction failed:", errText);
            }
          }
        }).catch((e) => console.error("WhatsApp reaction failed:", e))
      ),
      injectQuotedReply(
        sendWhatsappQuotedReply(token, toNumberId(msg))(fromNumber(msg)),
      ),
      referenceId(msg) ? injectReferenceId(() => referenceId(msg)) : identity,
    )(doTask)();
  };

export const whatsappBusinessHandler = (
  token: string,
  appSecret: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<WhatsappMessage> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  authenticate: ({ headers, rawBody }) =>
    verifyMetaSignature(appSecret, headers, rawBody),
  handler: whatsappForBusinessInjectDepsAndRun(token, doTask),
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
