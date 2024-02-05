import { letIn, map, withContext } from "gamla";
// @ts-expect-error no typing
import greenApi from "npm:@green-api/whatsapp-api-client";

import { TaskHandler } from "./api.ts";
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

const communications = (
  credentials: GreenCredentials,
  uploadToCloudStorage: StoreOnCloud,
) =>
  letIn(
    greenApi.restAPI(credentials),
    (api) => (userId: string) => ({
      fileLimitMB: () => 50,
      userId: () => userId,
      sendFile: async (file: string) =>
        api.file.sendFileByUrl(
          userId,
          null,
          await uploadToCloudStorage(file),
          "video.mp4",
          "",
        ),
      logText: (txt: string) => api.message.sendMessage(userId, null, txt),
      logURL: (text: string, url: string, urlText: string) =>
        map(
          (txt: string) => api.message.sendMessage(userId, null, txt),
        )([text, `${urlText}: ${url}`]),
    }),
  );

type StoreOnCloud = (path: string) => Promise<string>;

export const greenApiHandler = (
  greenCredentials: GreenCredentials,
  path: string,
  doTask: TaskHandler,
  uploadToCloudStorage: StoreOnCloud,
): Endpoint => ({
  bounce: true,
  method: "POST",
  path,
  handler: (msg: GreenApiMessage) =>
    withContext(
      communications(
        greenCredentials,
        uploadToCloudStorage,
      )(messageSender(msg)),
      doTask,
    )({ text: messageText(msg) }),
});
