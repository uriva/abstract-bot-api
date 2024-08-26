import {
  juxtCat,
  sideLog,
} from "https://deno.land/x/gamla@65.0.0/src/index.ts";
import { gamla } from "../deps.ts";
import {
  injectBotPhone,
  injectMessageId,
  injectReferenceId,
  injectReply,
  injectSpinner,
  injectUserId,
  RetainsType,
} from "./api.ts";
import { AbstractIncomingMessage, TaskHandler } from "./index.ts";
import { Endpoint } from "./taskBouncer.ts";

const { anymap, filter, join, coerce, letIn, pipe, empty, map, replace } =
  gamla;

const convertToWhatsAppFormat = (message: string): string =>
  message
    .replace(/<b>(.*?)<\/b>/g, "*$1*")
    .replace(/<u>(.*?)<\/u>/g, "_$1_")
    .replace(/<a href="https?:\/\/(.*?)">(.*?)<\/a>/g, "$2 - $1");

type SentMessageResponse = {
  messaging_product: "whatsapp";
  contacts: [{ input: string; wa_id: string }];
  messages: [{ id: string }];
};

export const sendWhatsappMessage =
  (accessToken: string, fromNumberId: string) => (to: string) =>
    pipe(convertToWhatsAppFormat, (body: string) =>
      fetch(
        `https://graph.facebook.com/v19.0/${fromNumberId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            recipient_type: "individual",
            type: "text",
            messaging_product: "whatsapp",
            to,
            text: { preview_url: false, body },
          }),
          headers: {
            "Authorization": `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
        },
      ).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as SentMessageResponse;
      }));

const bodyTextParams = pipe(
  map(pipe(replace(/\n|\t|(\s\s\s\s)/g, " | "), convertToWhatsAppFormat)),
  (texts: string[]) => ({
    type: "body",
    parameters: texts.map((text) => ({ type: "text", text })),
  }),
);

export const sendWhatsappTemplate =
  (accessToken: string, fromNumberId: string) =>
  (
    to: string,
    name: string,
    langCode: string,
    texts: string[],
  ) =>
    fetch(`https://graph.facebook.com/v19.0/${fromNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        recipient_type: "individual",
        messaging_product: "whatsapp",
        to,
        type: "template",
        template: {
          name,
          language: { code: langCode },
          components: [bodyTextParams(texts)],
        },
      }),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    }).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as SentMessageResponse;
    });

type CommonProps = { from: string; id: string; timestamp: string };

type TextMessage = CommonProps & {
  type: "text";
  text: { body: string };
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
    "caption": string;
    "mime_type": "image/jpeg";
    "sha256": string;
    "id": string;
  };
};

type InnerMessage =
  | ButtonReply
  | ContactsMessage
  | ImageMessage
  | ReactionMessage
  | RequestWelcome
  | TextMessage;

// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
type WhatsappMessage = {
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

const innerMessages = (message: WhatsappMessage) =>
  message.entry[0].changes[0].value.messages || [];

const fromNumber = pipe(
  innerMessages,
  (messages: InnerMessage[]) => messages?.[0].from,
);

const messageId = pipe(
  innerMessages,
  filter((x: InnerMessage) => x.type === "reaction"),
  (msgs: InnerMessage[]) => msgs[0].id,
);

const referenceId = pipe(
  innerMessages,
  sideLog<InnerMessage[]>,
  pipe(
    // @ts-expect-error typing change here
    filter(({ type }: InnerMessage) => type === "reaction"),
    map(({ reaction: { message_id } }: ReactionMessage) => message_id),
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
): Endpoint => ({
  method: "GET",
  bounce: false,
  path,
  handler: (msg: WebhookVerification) =>
    (
        msg["hub.mode"] === "subscribe" &&
        verifyToken === msg["hub.verify_token"]
      )
      ? Promise.resolve(msg["hub.challenge"])
      : Promise.resolve(),
});

const getText = (msg: WhatsappMessage) =>
  isWelcome(msg)
    ? { text: "/start" }
    : messageText(msg)
    ? { text: messageText(msg) }
    : {};

const getContacts = (
  msg: WhatsappMessage,
): Record<string, never> | { contact: AbstractIncomingMessage["contact"] } => {
  const contacts = innerMessages(msg).flatMap((x) =>
    x.type === "contacts" ? x.contacts : []
  );
  if (empty(contacts)) return {};
  const [{ phones: [{ phone }], name: { formatted_name: name } }] = contacts;
  return { contact: { phone, name } };
};

export const whatsappBusinessHandler = (
  token: string,
  whatsappPath: string,
  doTask: TaskHandler,
): Endpoint => ({
  bounce: true,
  method: "POST",
  path: whatsappPath,
  handler: (msg: WhatsappMessage) =>
    msg.entry[0].changes[0].value.messages
      ? letIn(
        sendWhatsappMessage(token, toNumberId(msg))(coerce(fromNumber(msg))),
        (send) =>
          pipe(
            injectMessageId(() => messageId(msg)),
            injectBotPhone(() => toNumber(msg)),
            injectUserId(() => coerce(fromNumber(msg))),
            injectSpinner(pipe(send, (_) => () => Promise.resolve())),
            injectReply(send),
            injectReferenceId(() => referenceId(msg)),
          ) as RetainsType,
      )(doTask)({ ...getText(msg), ...getContacts(msg) })
      : Promise.resolve(),
});
