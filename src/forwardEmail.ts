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

type Field = { value: { address: string; name: string }[]; text: string };

export type ForwardEmailWebhook = {
  from: Field;
  to: Field;
  subject: string;
  text: string;
  html: string;
  date: string; // ISO Date string
  messageId: string;
  attachments?: {
    filename: string;
    contentType: string;
    // deno-lint-ignore no-explicit-any
    content: any; // Buffer or Base64 string depending on config
    size: number;
    checksum: string;
  }[];
  headers: Record<string, string | string[] | undefined>;
  raw?: string;
};

export const getThreadingHeaders = (
  payload: ForwardEmailWebhook,
): Record<string, string> | undefined => {
  const headers: Record<string, string> = {};
  const messageId = payload.messageId;
  if (messageId && typeof messageId === "string") {
    headers["In-Reply-To"] = messageId;
    headers["References"] = messageId;
  } else if (messageId && typeof messageId === "object") {
    const msgIdValue = (messageId as Record<string, unknown>).value;
    if (Array.isArray(msgIdValue) && msgIdValue.length > 0) {
      const idStr = msgIdValue[0]?.toString();
      if (idStr) {
        headers["In-Reply-To"] = idStr;
        headers["References"] = idStr;
      }
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
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
