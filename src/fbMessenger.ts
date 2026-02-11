import { pipe } from "gamla";
import {
  type ImageReplyPayload,
  injectBotPhone,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectReply,
  injectReplyImage,
  injectSpinner,
  injectTyping,
  injectUserId,
  type MediaAttachment,
  type TaskHandler,
} from "./api.ts";
import {
  convertHtmlToFacebookFormat,
  makeHeaders,
  stripUndefined,
} from "./fbUtils.ts";
import type { Endpoint } from "./taskBouncer.ts";

const apiVersion = "v24.0";

export const convertToMessengerFormat = convertHtmlToFacebookFormat;

type SentMessageResponse = {
  recipient_id: string;
  message_id: string;
};

type MessagingType = "RESPONSE" | "UPDATE" | "MESSAGE_TAG";

export const sendMessengerMessage =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (msg: string, messagingType: MessagingType = "RESPONSE"): Promise<string> =>
    pipe(convertToMessengerFormat, (text: string) =>
      fetch(
        `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: messagingType,
            message: { text },
          }),
          headers: makeHeaders(accessToken),
        },
      ).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as SentMessageResponse;
      }).then(({ message_id }) => message_id))(msg);

type MessengerImagePayload = ImageReplyPayload | { attachment_id: string };

export const sendMessengerImage =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  async (
    image: MessengerImagePayload,
    messagingType: MessagingType = "RESPONSE",
  ): Promise<string> => {
    const caption = "caption" in image ? image.caption : undefined;

    let imagePayload: Record<string, unknown>;

    if ("attachment_id" in image) {
      imagePayload = { attachment_id: image.attachment_id };
    } else if ("link" in image) {
      imagePayload = {
        type: "image",
        payload: { url: image.link, is_reusable: true },
      };
    } else if ("data" in image) {
      const dataUrlMatch = image.data.match(/^data:(.+?);base64,(.+)$/i);
      const url = dataUrlMatch
        ? image.data
        : `data:image/jpeg;base64,${image.data}`;
      imagePayload = {
        type: "image",
        payload: { url, is_reusable: false },
      };
    } else {
      throw new Error(
        "sendMessengerImage requires an attachment_id, link, or data",
      );
    }

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: "POST",
        body: JSON.stringify(
          stripUndefined({
            recipient: { id: recipientId },
            messaging_type: messagingType,
            message: {
              attachment: imagePayload,
              ...(caption ? { text: convertToMessengerFormat(caption) } : {}),
            },
          }),
        ),
        headers: makeHeaders(accessToken),
      },
    );

    if (!response.ok) throw new Error(await response.text());

    const { message_id } = (await response.json()) as SentMessageResponse;
    return message_id;
  };

export const sendMessengerReply =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (
    messageId: string,
    text: string,
    messagingType: MessagingType = "RESPONSE",
  ): Promise<string> =>
    pipe(convertToMessengerFormat, (formattedText: string) =>
      fetch(
        `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({
            recipient: { id: recipientId },
            messaging_type: messagingType,
            message: { text: formattedText },
            reply_to: { mid: messageId },
          }),
          headers: makeHeaders(accessToken),
        },
      ).then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return (await response.json()) as SentMessageResponse;
      }).then(({ message_id }) => message_id))(text);

type AttachmentType = "image" | "video" | "audio" | "file";

export const sendMessengerAttachment =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (
    url: string,
    type: AttachmentType = "file",
    messagingType: MessagingType = "RESPONSE",
  ): Promise<string> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: messagingType,
          message: {
            attachment: {
              type,
              payload: { url, is_reusable: true },
            },
          },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as SentMessageResponse;
    }).then(({ message_id }) => message_id);

export const sendMessengerTypingAction =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (action: "typing_on" | "typing_off" | "mark_seen"): Promise<void> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient: { id: recipientId },
          sender_action: action,
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
    });

type ButtonTemplate = {
  type: "web_url" | "postback";
  title: string;
  url?: string;
  payload?: string;
};

export const sendMessengerButtonTemplate =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (
    text: string,
    buttons: ButtonTemplate[],
    messagingType: MessagingType = "RESPONSE",
  ): Promise<string> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: messagingType,
          message: {
            attachment: {
              type: "template",
              payload: {
                template_type: "button",
                text: convertToMessengerFormat(text),
                buttons,
              },
            },
          },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as SentMessageResponse;
    }).then(({ message_id }) => message_id);

type QuickReply = {
  content_type: "text" | "user_phone_number" | "user_email";
  title?: string;
  payload?: string;
  image_url?: string;
};

export const sendMessengerQuickReplies =
  (accessToken: string, pageId: string) =>
  (recipientId: string) =>
  (
    text: string,
    quickReplies: QuickReply[],
    messagingType: MessagingType = "RESPONSE",
  ): Promise<string> =>
    fetch(
      `https://graph.facebook.com/${apiVersion}/${pageId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          recipient: { id: recipientId },
          messaging_type: messagingType,
          message: {
            text: convertToMessengerFormat(text),
            quick_replies: quickReplies,
          },
        }),
        headers: makeHeaders(accessToken),
      },
    ).then(async (response) => {
      if (!response.ok) throw new Error(await response.text());
      return (await response.json()) as SentMessageResponse;
    }).then(({ message_id }) => message_id);

type MessengerWebhookEntry = {
  id: string;
  time: number;
  messaging: Array<{
    sender: { id: string };
    recipient: { id: string };
    timestamp: number;
    message?: {
      mid: string;
      text?: string;
      attachments?: Array<{
        type: string;
        payload: {
          url?: string;
        };
      }>;
    };
    postback?: {
      mid: string;
      payload: string;
      title: string;
    };
  }>;
};

type MessengerWebhookMessage = {
  object: "page";
  entry: MessengerWebhookEntry[];
};

const getMessageText = (msg: MessengerWebhookMessage): string => {
  const messaging = msg.entry[0]?.messaging?.[0];
  if (messaging?.message?.text) return messaging.message.text;
  if (messaging?.postback) return messaging.postback.payload;
  return "";
};

const getSenderId = (msg: MessengerWebhookMessage): string =>
  msg.entry[0]?.messaging?.[0]?.sender?.id ?? "";

const getMessageId = (msg: MessengerWebhookMessage): string =>
  msg.entry[0]?.messaging?.[0]?.message?.mid ?? "";

const getPageId = (msg: MessengerWebhookMessage): string =>
  msg.entry[0]?.id ?? "";

const getAttachments = (
  msg: MessengerWebhookMessage,
): MediaAttachment[] => {
  const attachments = msg.entry[0]?.messaging?.[0]?.message?.attachments;
  if (!attachments) return [];

  const result: MediaAttachment[] = [];
  for (const attachment of attachments) {
    if (attachment.type === "image" && attachment.payload.url) {
      result.push({
        kind: "file",
        mimeType: "image/jpeg",
        fileUri: attachment.payload.url,
      });
    } else if (attachment.type === "video" && attachment.payload.url) {
      result.push({
        kind: "file",
        mimeType: "video/mp4",
        fileUri: attachment.payload.url,
      });
    } else if (attachment.type === "audio" && attachment.payload.url) {
      result.push({
        kind: "file",
        mimeType: "audio/mpeg",
        fileUri: attachment.payload.url,
      });
    } else if (attachment.type === "file" && attachment.payload.url) {
      result.push({
        kind: "file",
        mimeType: "application/octet-stream",
        fileUri: attachment.payload.url,
      });
    }
  }
  return result;
};

export const fbMessengerInjectDepsAndRun =
  (accessToken: string, doTask: TaskHandler) =>
  (msg: MessengerWebhookMessage): Promise<void> => {
    const senderId = getSenderId(msg);
    const pageId = getPageId(msg);
    const messageId = getMessageId(msg);
    const text = getMessageText(msg);
    const attachments = getAttachments(msg);

    if (!senderId || !text) return Promise.resolve();

    const send = sendMessengerMessage(accessToken, pageId)(senderId);
    const sendImageReply = sendMessengerImage(accessToken, pageId)(senderId);
    const typing = sendMessengerTypingAction(accessToken, pageId)(senderId);

    return pipe(
      injectLastEvent(() => ({
        kind: "message" as const,
        text,
        attachments,
      })),
      injectMedium(() => "facebook-messenger"),
      injectMessageId(() => messageId),
      injectBotPhone(() => pageId),
      injectUserId(() => senderId),
      injectSpinner(pipe(send, (_) => () => Promise.resolve())),
      injectReply(send),
      injectReplyImage(sendImageReply),
      injectTyping(() =>
        typing("typing_on").catch((e) => {
          console.error(e);
        }).then(() => {})
      ),
    )(doTask)();
  };

export const messengerWebhookHandler = (
  accessToken: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<MessengerWebhookMessage> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: fbMessengerInjectDepsAndRun(accessToken, doTask),
});

type WebhookVerification = {
  "hub.mode": string;
  "hub.verify_token": string;
  "hub.challenge": string;
};

export const messengerWebhookVerificationHandler = (
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
