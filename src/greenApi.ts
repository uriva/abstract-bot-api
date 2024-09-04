import { gamla } from "../deps.ts";

import greenApi from "npm:@green-api/whatsapp-api-client@0.4.0-0";

const { pipe } = gamla;

import {
  injectFileLimitMB,
  injectMedium,
  injectMessageId,
  injectReferenceId,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectUserId,
  TaskHandler,
} from "./api.ts";
import { Endpoint } from "./index.ts";

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
  idMessage: string;
  timestamp: number;
  senderData: SenderData;
  messageData:
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

const messageSender = ({
  senderData: { sender },
}: GreenApiMessage) => sender;

const greenApiReferenceId = (x: GreenApiMessage) =>
  x.messageData.quotedMessage?.stanzaId;

const messageText = ({ messageData }: GreenApiMessage) =>
  messageData.typeMessage === "extendedTextMessage"
    ? messageData.extendedTextMessageData.text
    : messageData.textMessageData.textMessage;

export const registerWebhook = (
  credentials: GreenCredentials,
  webhookUrl: string,
) => greenApi.restAPI(credentials).settings.setSettings({ webhookUrl });

const communications = <T extends TaskHandler>(
  api: ReturnType<typeof greenApi.restAPI>,
  msgId: string,
  referenceId: string,
  userId: string,
  send: (txt: string) => Promise<string>,
) =>
  pipe(
    injectMedium(() => "green-api")<T>,
    injectMessageId(() => msgId)<T>,
    injectFileLimitMB(() => 50)<T>,
    injectUserId(() => userId)<T>,
    injectSendFile((url: string) =>
      api.file.sendFileByUrl(userId, null, url, "video.mp4", "")
    )<T>,
    injectReferenceId(() => referenceId)<T>,
    injectSpinner(pipe(send, (_) => () => Promise.resolve()))<T>,
    injectReply(send)<T>,
  );

export const greenApiHandler = (
  credentials: GreenCredentials,
  path: string,
  doTask: TaskHandler,
): Endpoint => ({
  bounce: true,
  method: "POST",
  path,
  handler: (msg: GreenApiMessage) =>
    communications(
      greenApi.restAPI(credentials),
      msg.idMessage,
      greenApiReferenceId(msg) ?? "",
      messageSender(msg),
      (txt: string) =>
        greenApi.restAPI(credentials).message.sendMessage(
          messageSender(msg),
          null,
          txt,
        ).then(({ idMessage }: MessageResponse) => idMessage),
    )(doTask)({ text: messageText(msg) }),
});
