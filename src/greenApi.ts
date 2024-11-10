import { gamla } from "../deps.ts";

// @ts-expect-error no types
import greenApi from "npm:@green-api/whatsapp-api-client@0.4.0-0";

const { pipe, replace, identity } = gamla;

import {
  injectBotPhone,
  injectFileLimitMB,
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
) => greenApi.restAPI(credentials).settings.setSettings({ webhookUrl });

const communications = <T extends TaskHandler>(
  api: ReturnType<typeof greenApi.restAPI>,
  botPhone: string,
  msgId: string,
  referenceId: string | undefined,
  userId: string,
  send: (txt: string) => Promise<string>,
) =>
  pipe(
    injectBotPhone(() => botPhone)<T>,
    injectMedium(() => "green-api")<T>,
    injectMessageId(() => msgId)<T>,
    injectFileLimitMB(() => 50)<T>,
    injectUserId(() => userId)<T>,
    injectSendFile((url: string) =>
      api.file.sendFileByUrl(userId, null, url, "video.mp4", "")
    )<T>,
    referenceId ? injectReferenceId(() => referenceId)<T> : identity,
    injectSpinner(pipe(send, (_) => () => Promise.resolve()))<T>,
    injectReply(send)<T>,
  );

export const sendGreenApiMessage =
  (secrets: GreenCredentials) => (to: string) =>
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
      greenApi.restAPI(credentials),
      rewriteNumber(msg.instanceData.wid),
      msg.idMessage,
      greenApiReferenceId(msg),
      messageSender(msg),
      sendGreenApiMessage(credentials)(messageSender(msg)),
    )(doTask)({ text: messageText(msg) }),
});
