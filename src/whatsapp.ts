import { coerce } from "gamla";
import { withContextTyped } from "./api.ts";
import { TaskHandler } from "./index.ts";
import { Endpoint } from "./taskBouncer.ts";

const sendMessage =
  (accessToken: string, from: string, to: string) => (body: string) =>
    fetch(
      `https://graph.facebook.com/v12.0/${from}/messages?access_token=${accessToken}`,
      {
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          text: { body },
        }),
        headers: { "Content-Type": "application/json" },
      },
    );

// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
type WhatsappMessage = {
  object: string;
  entry: {
    changes: {
      value: {
        metadata: { phone_number_id: string };
        messages?: { from: string; text: { body: string } }[];
      };
    }[];
  }[];
};

type WebhookVerification = {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
};

const fromNumber = (
  msg: WhatsappMessage,
) => msg.entry[0].changes[0].value.messages?.[0].from;

const messageText = (
  msg: WhatsappMessage,
) => msg.entry[0].changes[0].value.messages?.[0].text.body;

const toNumber = (
  { entry: [{ changes: [{ value: { metadata: { phone_number_id } } }] }] }:
    WhatsappMessage,
) => phone_number_id;

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
      ? withContextTyped(
        {
          userId: () => coerce(fromNumber(msg)),
          logText: sendMessage(
            accessToken,
            toNumber(msg),
            coerce(fromNumber(msg)),
          ),
        },
        doTask,
      )({ text: messageText(msg) })
      : Promise.resolve(),
});
