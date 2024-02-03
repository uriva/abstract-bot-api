import {
  coerce,
  juxt,
  letIn,
  max,
  pipe,
  prop,
  retry,
  sleep,
  throttle,
  withContext,
} from "gamla";
import {
  Contact,
  File,
  Message,
  ParseMode,
  PhotoSize,
  Update,
  User,
} from "grammy_types";
import fs from "node:fs";
import { Telegraf, Telegram } from "npm:telegraf";

import { encodeBase64 } from "https://deno.land/std@0.207.0/encoding/base64.ts";
import { Context, TaskHandler } from "./api.ts";
import { AbstractIncomingMessage } from "./index.ts";

export const sendFile = (tgm: Telegram, uid: number) => (path: string) =>
  retry(
    3000,
    2,
    (uid: number, path) =>
      tgm.sendVideo(uid, { source: fs.createReadStream(path) }),
  )(uid, path);

const progressMessage =
  (text: string, progressBarLength: number) => (progress: number) => {
    const completedLength = Math.round(progress * progressBarLength);
    const progressBar = "▓".repeat(completedLength) +
      "░".repeat(progressBarLength - completedLength);
    return `${text} [${progressBar}] ${Math.round(progress * 100)}%`;
  };

const telegramProgressBar = (tgm: Telegram, uid: number) => (text: string) => {
  const bar = progressMessage(text, 20);
  let lastValue = 0;
  let msgId: number | null = null;
  tgm.sendMessage(uid, bar(lastValue)).then(({ message_id }) => {
    msgId = message_id;
  });
  return throttle(1, (progress: number) => {
    if (bar(progress) === bar(lastValue) || !msgId) return Promise.resolve();
    lastValue = progress;
    return tgm
      .editMessageText(uid, msgId, undefined, bar(progress))
      .catch(() => {});
  });
};

const spinnerMessages = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const makeSpinner = (tgm: Telegram, uid: number) => async (text: string) => {
  const messageId = await tgm
    .sendMessage(uid, `${text} ${spinnerMessages[0]}`)
    .then(({ message_id }) => message_id);
  let finished = false;
  const update = async (frame: number): Promise<void> => {
    if (finished) return;
    await tgm
      .editMessageText(
        uid,
        messageId,
        undefined,
        `${text} ${spinnerMessages[frame]}`,
        // It may throw an error about the old text being the same as the new, this is not interesting and in general this update doesn't have to succeed.
      ).catch(() => {});
    await sleep(500);
    return update((frame + 1) % spinnerMessages.length);
  };
  const spinning = update(0);
  return async () => {
    finished = true;
    await spinning;
    return tgm.editMessageText(uid, messageId, undefined, `${text} done.`);
  };
};

const adminSpyMessage = (
  { id, username, first_name, last_name }: User,
  msg: string,
) => `${id} ${username} ${first_name} ${last_name}: ${msg}`;

const messageOptions = {
  disable_web_page_preview: true,
  parse_mode: "HTML" as ParseMode,
};

const tokenToTelegramURL = (token: string) =>
  `https://api.telegram.org/bot${token}/`;

export const sendTelegramMessage = (token: string) =>
  pipe(
    retry(2, 500, (chat_id: number, text: string) =>
      fetch(`${tokenToTelegramURL(token)}sendMessage`, {
        method: "POST",
        headers: { "Content-type": "application/json" },
        body: JSON.stringify({ chat_id, text, ...messageOptions }),
      }).then((r) =>
        r.json()
      )),
    ({ ok, error_code, description }) => {
      if (error_code === 403) {
        return;
      }
      if (!ok) {
        throw new Error(`Telegram error: ${error_code} ${description}`);
      }
    },
  );

export const setTelegramWebhook = (token: string, url: string) =>
  fetch(tokenToTelegramURL(token) + `setWebhook?url=${url}`);

const fileIdToContentBase64 =
  (token: string) => async (fileId: string): Promise<string> => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    );
    if (!response.ok) throw new Error("could not fetch photo url");
    const { result: { file_path } } = (await response.json()) as {
      result: File;
    };
    const imageResponse = await fetch(
      `https://api.telegram.org/file/bot${token}/${file_path}`,
    );
    if (!imageResponse.ok) throw new Error("could not fetch photo");
    return encodeBase64(await imageResponse.arrayBuffer());
  };

const image = (token: string) =>
  pipe(
    max(prop<PhotoSize>()("width")),
    prop<PhotoSize>()("file_id"),
    fileIdToContentBase64(token),
  );

const sharedOwnPhone = (ownId: number, { user_id, phone_number }: Contact) =>
  (user_id === ownId) ? phone_number : undefined;

const contactToFullName = ({ first_name, last_name }: Contact) =>
  first_name + (last_name ? " " + last_name : "");

export const getBestPhoneFromContactShared = ({
  phone_number,
  vcard,
}: Contact) => {
  if (!vcard) return phone_number;
  const lines = vcard.split("\n");
  const preferredCellphone = lines.find(
    (x) => x.startsWith("TEL;CELL;PREF") || x.startsWith("TEL;MOBILE;PREF"),
  );
  if (preferredCellphone) return preferredCellphone.split(":")[1];
  const anyCellphone = lines.find(
    (x) => x.startsWith("TEL;CELL") || x.startsWith("TEL;MOBILE"),
  );
  if (anyCellphone) return anyCellphone.split(":")[1];
  return phone_number;
};

const abstractMessage = (token: string) =>
async (
  msg: Message,
): Promise<AbstractIncomingMessage> => ({
  text: msg.text,
  contact: msg.contact && {
    name: contactToFullName(msg.contact),
    phone: getBestPhoneFromContactShared(msg.contact),
  },
  image: msg.photo && await image(token)(msg.photo),
  caption: msg.caption,
  ownPhone: msg.contact && sharedOwnPhone(coerce(msg.from?.id), msg.contact),
});

export const makeTelegramHandler = (
  telegramToken: string,
  doTask: TaskHandler,
  logAdmin: Context["logAdmin"],
  logAdminVideo: Context["sendFile"],
  isAdmin: (user: User) => boolean,
) =>
({ message }: Update) =>
  message?.from && message.text
    ? pipe(
      abstractMessage(telegramToken),
      withContext(
        letIn(
          {
            from: message.from,
            tgm: new Telegraf(telegramToken, { handlerTimeout: Infinity })
              .telegram,
            logAdminIfNeeded: (msg: string) =>
              isAdmin(message.from)
                ? Promise.resolve()
                : logAdmin(adminSpyMessage(message.from, msg)),
            logAdminVideoIfNeeded: (path: string) =>
              isAdmin(message.from) ? Promise.resolve() : logAdminVideo(path),
          },
          ({ from, tgm, logAdminIfNeeded, logAdminVideoIfNeeded }) => ({
            userId: () => message.from.id.toString(),
            logAdmin,
            fileLimitMB: () => 50,
            sendFile: juxt(logAdminVideoIfNeeded, sendFile(tgm, from.id)),
            logText: juxt(
              (t: string) => sendTelegramMessage(telegramToken)(from.id, t),
              logAdminIfNeeded,
            ),
            makeProgressBar: telegramProgressBar(tgm, from.id),
            spinner: makeSpinner(tgm, from.id),
            logURL: pipe(
              (text: string, url: string, urlText: string) =>
                `${text}\n\n<a href="${url}">${urlText}</a>`,
              juxt(
                (t: string) => sendTelegramMessage(telegramToken)(from.id, t),
                logAdminIfNeeded,
              ),
            ),
          }),
        ),
        doTask,
      ),
    )(message)
    : Promise.resolve();
