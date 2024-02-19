import { pipe } from "gamla";
// @ts-expect-error no typing
import greenApi from "npm:@green-api/whatsapp-api-client";

import {
  injectFileLimitMB,
  injectReply,
  injectSendFile,
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

type SenderData = {
  chatId: string;
  chatName: string;
  sender: string;
  senderName: string;
};

type GreenApiMessage = {
  idMessage: string;
  timestamp: number;
  senderData: SenderData;
  messageData:
    | {
      typeMessage: "textMessage";
      textMessageData: { textMessage: string };
    }
    | {
      typeMessage: "extendedTextMessage";
      extendedTextMessageData: ExtendedTextMessageData;
    };
};

const messageSender = ({
  senderData: { sender },
}: GreenApiMessage) => sender;

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
  userId: string,
) =>
  pipe(
    injectFileLimitMB(() => 50)<T>,
    injectUserId(() => userId)<T>,
    injectSendFile((url: string) =>
      api.file.sendFileByUrl(userId, null, url, "video.mp4", "")
    )<T>,
    injectReply((txt: string) => api.message.sendMessage(userId, null, txt))<
      T
    >,
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
    communications(greenApi.restAPI(credentials), messageSender(msg))(doTask)({
      text: messageText(msg),
    }),
});
