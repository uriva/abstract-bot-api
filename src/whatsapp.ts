import { anymap, coerce, letIn, pipe, sideLog } from "gamla";
import {
  injectBotPhone,
  injectReply,
  injectSpinner,
  injectUserId,
} from "./api.ts";
import { TaskHandler } from "./index.ts";
import { Endpoint } from "./taskBouncer.ts";

export const sendWhatsappMessage =
  (accessToken: string, fromNumberId: string) =>
  (to: string) =>
  (body: string) =>
    fetch(
      sideLog(`https://graph.facebook.com/v19.0/${fromNumberId}/messages`),
      {
        method: "POST",
        body: JSON.stringify({
          recipient_type: "individual",
          type: "text",
          messaging_product: "whatsapp",
          to: sideLog(to),
          text: { preview_url: false, body: sideLog(body) },
        }),
        headers: {
          "Authorization": `Bearer ${sideLog(accessToken)}`,
          "Content-Type": "application/json",
        },
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
    });

type TextMessage = {
  id: string;
  type: "text";
  timestamp: string;
  from: string;
  text: { "body": string };
};

type RequestWelcome = {
  id: string;
  type: "request_welcome";
  timestamp: string;
  from: string;
};

type InnerMessage = TextMessage | RequestWelcome;

// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
type WhatsappMessage = {
  object: string;
  entry: {
    changes: {
      value: {
        metadata: { phone_number_id: string; display_phone_number: string };
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

const innerMessageTypeEquals =
  (x: InnerMessage["type"]) => ({ type }: InnerMessage) => type === x;

const innerMessages = (message: WhatsappMessage) =>
  message.entry[0].changes[0].value.messages || [];

const fromNumber = pipe(innerMessages, (
  messages: InnerMessage[],
) => messages?.[0].from);

const messageText = pipe(
  innerMessages,
  (messages: InnerMessage[]) =>
    (messages.filter(innerMessageTypeEquals("text"))?.[0] as TextMessage).text
      .body,
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
  handler: (msg: WebhookVerification) => {
    if (
      msg["hub.mode"] === "subscribe" &&
      verifyToken === msg["hub.verify_token"]
    ) return Promise.resolve(msg["hub.challenge"]);
    return Promise.resolve();
  },
});

const convertToWhatsAppFormat = (message: string): string =>
  message
    .replace(/<b>(.*?)<\/b>/g, "*$1*")
    .replace(/<u>(.*?)<\/u>/g, "_$1_")
    .replace(/<a href="(.*?)">(.*?)<\/a>/g, "$2 - $1");

export const whatsappBusinessHandler = (
  accessToken: string,
  whatsappPath: string,
  doTask: TaskHandler,
): Endpoint => ({
  bounce: true,
  method: "POST",
  path: whatsappPath,
  handler: (msg: WhatsappMessage) =>
    msg.entry[0].changes[0].value.messages
      ? letIn(
        sendWhatsappMessage(
          accessToken,
          toNumberId(msg),
        )(coerce(fromNumber(msg))),
        (send) =>
          pipe(
            injectBotPhone(() => toNumber(msg))<TaskHandler>,
            injectUserId(() => coerce(fromNumber(msg)))<TaskHandler>,
            injectSpinner((x: string) =>
              send(x).then(() => () => Promise.resolve())
            )<TaskHandler>,
            injectReply(pipe(
              convertToWhatsAppFormat,
              send,
            ))<TaskHandler>,
          ),
      )(doTask)({ text: isWelcome(msg) ? "/start" : messageText(msg) })
      : Promise.resolve(),
});
