import type { Injector } from "@uri/inject";
import { pipe } from "gamla";
import { compile } from "html-to-text";
import { injectMedium, injectReply, injectUserId } from "./api.ts";

const converter = compile({
  selectors: [{ selector: "a", options: { hideLinkHrefIfSameAsText: true } }],
});

type Email = {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
};

type Field = {
  value: { address: string; name: string; text: string; html: string }[];
};

export type ForwardEmailWebhook = {
  from: Field;
  to: Field;
  text: string;
  html: string;
};

const sendEmail = (key: string) => (email: Email) =>
  fetch("https://api.forwardemail.net/v1/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${key}`,
    },
    body: JSON.stringify({ ...email, encoding: "utf-8" }),
  });

const pushToEmail =
  (key: string) =>
  (from: string) =>
  ({ subject, html }: { subject: string; html: string }) =>
    pipe(
      (emailAddress: string) => ({
        to: emailAddress,
        from,
        subject,
        text: converter(html),
        html,
      }),
      sendEmail(key),
    );

export const forwardEmailInjectDeps = (
  apiKey: string,
  fromEmail: string,
  incomingMessage: ForwardEmailWebhook,
): Injector =>
  pipe(
    injectMedium(() => "email"),
    injectUserId(() => incomingMessage.from.value[0].address),
    injectReply(async (text: string) => {
      await pushToEmail(apiKey)(fromEmail)({
        subject: `Re: ${incomingMessage.to.value[0].address}`,
        html: text,
      })(incomingMessage.from.value[0].address);
      return crypto.randomUUID();
    }),
  );
