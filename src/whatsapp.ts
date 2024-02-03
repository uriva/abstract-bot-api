import { letIn, map, withContext } from "gamla";
// @ts-expect-error no typing
import whatsAppClient from "npm:@green-api/whatsapp-api-client";

import { TaskHandler } from "./api.ts";

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

type WhatsappMessage = {
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

const senderFromWhatsappMessage = ({
  senderData: { sender },
}: WhatsappMessage) => sender;

const textFromWhatsappMessage = ({ messageData }: WhatsappMessage) =>
  messageData.typeMessage === "extendedTextMessage"
    ? messageData.extendedTextMessageData.text
    : messageData.textMessageData.textMessage;

export const registerWebhook = (
  credentials: GreenCredentials,
  webhookUrl: string,
) => whatsAppClient.restAPI(credentials).settings.setSettings({ webhookUrl });

const whatsappCommunications = (
  credentials: GreenCredentials,
  uploadToCloudStorage: StoreOnCloud,
) =>
  letIn(
    whatsAppClient.restAPI(credentials),
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

export const whatsappHandler = (
  greenCredentials: GreenCredentials,
  doTask: TaskHandler,
  uploadToCloudStorage: StoreOnCloud,
) =>
(msg: WhatsappMessage) =>
  withContext(
    whatsappCommunications(
      greenCredentials,
      uploadToCloudStorage,
    )(senderFromWhatsappMessage(msg)),
    doTask,
  )({ text: textFromWhatsappMessage(msg) });
