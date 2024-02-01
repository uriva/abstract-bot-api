import { juxt, letIn, pipe, retry, sleep, throttle, withContext } from "gamla";
import {
  ParseMode,
  Update,
  User,
} from "https://deno.land/x/grammy_types@v3.3.0/mod.ts";
import fs from "node:fs";
import { Telegraf, Telegram, TelegramError } from "npm:telegraf";

import { Context, TaskHandler } from "./api.ts";

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
    if (messageId) {
      await tgm
        .editMessageText(
          uid,
          messageId,
          undefined,
          `${text} ${spinnerMessages[frame]}`,
        )
        .catch(() => {});
    }
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

export const sendMessage = (tgm: Telegram, userId: number) =>
  retry(1000, 2, async (txt: string) => {
    console.log(txt);
    try {
      return await tgm.sendMessage(userId, txt, messageOptions);
    } catch (error) {
      if ((error as TelegramError).code === 403) return;
      throw error;
    }
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
    ? withContext(
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
          logText: juxt(sendMessage(tgm, from.id), logAdminIfNeeded),
          makeProgressBar: telegramProgressBar(tgm, from.id),
          spinner: makeSpinner(tgm, from.id),
          logURL: pipe(
            (text: string, url: string, urlText: string) =>
              `${text}\n\n<a href="${url}">${urlText}</a>`,
            juxt(sendMessage(tgm, from.id), logAdminIfNeeded),
          ),
        }),
      ),
      doTask,
    )({ text: message.text })
    : Promise.resolve();
