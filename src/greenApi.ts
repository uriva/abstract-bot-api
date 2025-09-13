import greenApi from "@green-api/whatsapp-api-client";
import { pipe, replace } from "gamla";

import {
  injectBotPhone,
  injectFileLimitMB,
  injectLastEvent,
  injectMedium,
  injectMessageId,
  injectReferenceId,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectUserId,
  type TaskHandler,
} from "./api.ts";
import type { Endpoint } from "./index.ts";
import { convertToWhatsAppFormat } from "./whatsapp.ts";

export type GreenCredentials = { idInstance: string; apiTokenInstance: string };

type ExtendedTextMessageData = {
  text: string;
  description: string;
  title: string;
  previewType: string;
  jpegThumbnail: string;
  forwardingScore: number;
  isForwarded: false;
};

type MessageResponse = {
  idMessage: string;
};

type SenderData = {
  chatId: string;
  chatName: string;
  sender: string;
  senderName: string;
};

type QuotedMessage = {
  stanzaId: string;
  participant: string;
  typeMessage: string;
  // More fields according to the type.
  // See here https://green-api.com/en/docs/api/receiving/notifications-format/.
};

type GreenApiMessage = {
  typeWebhook: "incomingMessageReceived";
  instanceData: {
    idInstance: number;
    wid: string;
    typeInstance: "whatsapp";
  };
  idMessage: string;
  timestamp: number;
  senderData: SenderData;
  messageData:
    | {
      typeMessage: "quotedMessage";
      extendedTextMessageData: ExtendedTextMessageData;
      quotedMessage: QuotedMessage;
    }
    | {
      typeMessage: "textMessage";
      textMessageData: { textMessage: string };
      quotedMessage?: QuotedMessage;
    }
    | {
      typeMessage: "extendedTextMessage";
      extendedTextMessageData: ExtendedTextMessageData;
      quotedMessage?: QuotedMessage;
    };
};

const phoneSuffix = "@c.us";

const rewriteNumber = replace(phoneSuffix, "");

const messageSender = ({
  senderData: { sender },
}: GreenApiMessage) => rewriteNumber(sender);

const greenApiReferenceId = (x: GreenApiMessage) =>
  x.messageData.quotedMessage?.stanzaId;

const messageText = ({ messageData }: GreenApiMessage) =>
  messageData.typeMessage === "extendedTextMessage" ||
    messageData.typeMessage === "quotedMessage"
    ? messageData.extendedTextMessageData.text
    : messageData.textMessageData.textMessage;

export const registerWebhook = (
  credentials: GreenCredentials,
  webhookUrl: string,
): Promise<greenApi.Settings.SetSettings> =>
  greenApi.restAPI(credentials).settings.setSettings({ webhookUrl });

const communications = (
  text: string,
  api: ReturnType<typeof greenApi.restAPI>,
  botPhone: string,
  msgId: string,
  referenceId: string | undefined,
  userId: string,
  send: (txt: string) => Promise<string>,
) => {
  const f = pipe(
    injectLastEvent(() => ({ text })),
    injectBotPhone(() => botPhone),
    injectMedium(() => "green-api"),
    injectMessageId(() => msgId),
    injectFileLimitMB(() => 50),
    injectUserId(() => userId),
    injectSendFile((url: string) =>
      api.file.sendFileByUrl(userId, null, url, "video.mp4", "").then(() => {})
    ),
    injectSpinner(pipe(send, (_) => () => Promise.resolve())),
    injectReply(send),
  );
  return referenceId ? injectReferenceId(() => referenceId)(f) : f;
};

export const sendGreenApiMessage =
  (secrets: GreenCredentials) =>
  (to: string): (msg: string) => Promise<string> =>
    pipe(
      convertToWhatsAppFormat,
      (txt: string) =>
        greenApi.restAPI(secrets).message.sendMessage(
          to + phoneSuffix,
          null,
          txt,
        ),
      ({ idMessage }: MessageResponse) => idMessage,
    );

export const greenApiHandler = (
  credentials: GreenCredentials,
  path: string,
  doTask: TaskHandler,
): Endpoint<GreenApiMessage> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: (msg: GreenApiMessage) =>
    communications(
      messageText(msg),
      greenApi.restAPI(credentials),
      rewriteNumber(msg.instanceData.wid),
      msg.idMessage,
      greenApiReferenceId(msg),
      messageSender(msg),
      sendGreenApiMessage(credentials)(messageSender(msg)),
    )(doTask)(),
});
