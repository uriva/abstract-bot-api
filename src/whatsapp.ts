import { decodeBase64, encodeBase64 } from "@std/encoding";
import {
  anymap,
  coerce,
  empty,
  filter,
  identity,
  join,
  juxtCat,
  letIn,
  map,
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
  injectReferenceId,
  injectReply,
  injectReplyImage,
  injectSpinner,
  injectTyping,
  injectUserId,
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

type CommonProps = { from: string; id: string; timestamp: string };

type TextMessage = CommonProps & {
  type: "text";
  text: { body: string };
  context?: { from: string; id: string };
};

type ReactionMessage = CommonProps & {
  type: "reaction";
  reaction: { message_id: string; emoji: string };
};

type ButtonReply = CommonProps & {
  type: "button";
  // deno-lint-ignore no-explicit-any
  button: { payload: any; text: string };
};

type ContactsMessage = CommonProps & {
  type: "contacts";
  contacts: {
    "addresses": [{
      "city": string;
      "country": string;
      "country_code": string;
      "state": string;
      "street": string;
      "type": string;
      "zip": string;
    }];
    "birthday": string;
    "emails": [{
      "email": string;
      "type": "HOME" | "WORK";
    }];
    "name": {
      "formatted_name": string;
      "first_name": string;
      "last_name": string;
      "middle_name": string;
      "suffix": string;
      "prefix": string;
    };
    "org": {
      "company": string;
      "department": string;
      "title": string;
    };
    "phones": [{
      "phone": string;
      "wa_id": string;
      "type": "HOME" | "WORK";
    }];
    "urls": [{
      "url": string;
      "type": "HOME" | "WORK";
    }];
  }[];
};

type RequestWelcome = CommonProps & {
  type: "request_welcome";
};

type ImageMessage = CommonProps & {
  type: "image";
  image: {
    caption: string;
    id: string;
    mime_type: "image/jpeg";
    sha256: string;
  };
};
type VideoMessage = CommonProps & {
  type: "video";
  video: {
    caption: string;
    id: string;
    mime_type: string;
    sha256: string;
  };
};

type InnerMessage =
  | ButtonReply
  | ContactsMessage
  | ImageMessage
  | ReactionMessage
  | RequestWelcome
  | TextMessage
  | VideoMessage;

// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
export type WhatsappMessage = {
  object: string;
  entry: {
    changes: {
      value: {
        messaging_product: "whatsapp";
        metadata: { phone_number_id: string; display_phone_number: string };
        contacts?: { profile: { name: string }; wa_id: string }[];
        messages?: InnerMessage[];
      };
    }[];
  }[];
};

type WebhookVerification = {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
};

const innerMessageTypeEquals = (y: string) => (x: InnerMessage) =>
  "type" in x && x.type === y;

const innerMessages = (msg: WhatsappMessage) =>
  msg.entry[0].changes[0].value.messages || [];

const fromNumber = pipe(
  innerMessages,
  (messages: InnerMessage[]) => messages?.[0].from,
);

const messageId = pipe(
  innerMessages,
  (msgs: InnerMessage[]) => msgs[0].id,
);

const referenceId = pipe(
  innerMessages,
  juxtCat(
    pipe(
      filter((msg: InnerMessage): msg is TextMessage =>
        msg.type === "text" && !!msg.context
      ),
      map((x: TextMessage) => x.context?.id || ""),
    ),
    pipe(
      filter((msg: InnerMessage) => msg.type === "reaction"),
      map(({ reaction: { message_id } }: ReactionMessage) => message_id),
    ),
  ),
  ([x]: string[]) => x || "",
);

const messageText = pipe(
  innerMessages,
  map((msg: InnerMessage): string =>
    msg.type === "text"
      ? msg.text.body
      : msg.type === "button"
      ? msg.button.text
      : msg.type === "image"
      ? msg.image.caption
      : msg.type === "reaction"
      ? msg.reaction.emoji
      : msg.type === "video"
      ? msg.video.caption
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

const getMediaFromId = (accessToken: string) => (id: string): Promise<string> =>
  fetch(`https://graph.facebook.com/${apiVersion}/${id}`, {
    method: "GET",
    headers: makeHeaders(accessToken),
  })
    .then((response) => response.json() as Promise<MediaGetResponse>)
    .then(({ url }) =>
      fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      })
    )
    .then((response) => (response.arrayBuffer()))
    .then(encodeBase64);

const getText = (accessToken: string) =>
async (msg: WhatsappMessage): Promise<{
  image?: string | undefined;
  text: string;
}> => ({
  text: isWelcome(msg) ? "/start" : messageText(msg),
  ...(msg.entry[0].changes[0].value?.messages?.[0].type === "image"
    ? {
      image: await getMediaFromId(accessToken)(
        msg.entry[0].changes[0].value.messages[0].image.id,
      ),
    }
    : {}),
});

const getContacts = (
  msg: WhatsappMessage,
): Record<string, never> | { contact: ConversationEvent["contact"] } => {
  const contacts = innerMessages(msg).flatMap((x) =>
    x.type === "contacts" ? x.contacts : []
  );
  if (empty(contacts)) return {};
  const [{ phones: [{ phone }], name: { formatted_name: name } }] = contacts;
  return { contact: { phone, name } };
};

export const whatsappForBusinessInjectDepsAndRun =
  (token: string, doTask: TaskHandler) =>
  async (msg: WhatsappMessage): Promise<void> =>
    nonempty(innerMessages(msg))
      ? letIn(
        {
          event: { ...await getText(token)(msg), ...getContacts(msg) },
          send: sendWhatsappMessage(token, toNumberId(msg))(fromNumber(msg)),
          sendImageReply: sendWhatsappImage(token, toNumberId(msg))(
            fromNumber(msg),
          ),
        },
        ({ send, sendImageReply, event }) =>
          pipe(
            injectLastEvent(() => event),
            injectMedium(() => "whatsapp"),
            injectMessageId(() => messageId(msg)),
            injectBotPhone(() => toNumber(msg)),
            injectUserId(() => coerce(fromNumber(msg))),
            injectSpinner(pipe(send, (_) => () => Promise.resolve())),
            injectReply(send),
            injectReplyImage(sendImageReply),
            injectTyping(() =>
              sendWhatsappTypingIndicator(token, toNumberId(msg))(
                messageId(msg),
              ).catch((e) => {
                console.error(e);
              }).then(() => {})
            ),
            referenceId(msg)
              ? injectReferenceId(() => referenceId(msg))
              : identity,
          )(doTask)(),
      )
      : Promise.resolve();

export const whatsappBusinessHandler = (
  token: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<WhatsappMessage> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
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
