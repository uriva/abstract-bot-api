import { Readable } from "node:stream";
import { Telegraf, Telegram } from "npm:telegraf";

import { gamla, grammy } from "../deps.ts";

const { coerce, letIn, max, pipe, prop, retry, sleep, throttle } = gamla;

import { encodeBase64 } from "https://deno.land/std@0.207.0/encoding/base64.ts";
import { get } from "node:https";
import {
  injectFileLimitMB,
  injectProgressBar,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectUserId,
  TaskHandler,
} from "./api.ts";
import { AbstractIncomingMessage, Endpoint } from "./index.ts";

const createUrlReadStream = (url: string): Readable => {
  const readable = new Readable({ read() {} });
  get(url, (response) => {
    // deno-lint-ignore no-explicit-any
    response.on("data", (chunk: any) => {
      readable.push(chunk);
    });
    response.on("end", () => {
      readable.push(null);
    });
  }).on("error", (error) => {
    readable.emit("error", error);
  });
  return readable;
};

export const sendFileTelegram =
  (tgm: Telegram, uid: number) => (path: string) =>
    retry(
      3000,
      2,
      (
        uid: number,
        path: string,
      ) => (path.includes(".gif")
        ? tgm.sendAnimation(uid, path)
        : tgm.sendVideo(uid, { source: createUrlReadStream(path) })),
    )(uid, path);

const progressMessage =
  (text: string, progressBarLength: number) => (progress: number) => {
    const completedLength = Math.round(progress * progressBarLength);
    const progressBar = "▓".repeat(completedLength) +
      "░".repeat(progressBarLength - completedLength);
    return `${text} [${progressBar}] ${Math.round(progress * 100)}%`;
  };

const telegramProgressBar =
  (tgm: Telegram, uid: number) => async (text: string) => {
    const bar = progressMessage(text, 20);
    let lastValue = 0;
    const { message_id } = await tgm.sendMessage(uid, bar(lastValue));
    return throttle(1, (progress: number) => {
      if (bar(progress) === bar(lastValue)) return Promise.resolve();
      lastValue = progress;
      return tgm
        .editMessageText(uid, message_id, undefined, bar(progress)).then();
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
      ).then().catch(() => {});
    await sleep(500);
    return update((frame + 1) % spinnerMessages.length);
  };
  const spinning = update(0);
  return async () => {
    finished = true;
    await spinning;
    return tgm.editMessageText(uid, messageId, undefined, `${text} done.`)
      .then(() => {});
  };
};

const tokenToTelegramURL = (token: string) =>
  `https://api.telegram.org/bot${token}/`;

export const sendTelegramMessage = (token: string) =>
  pipe(
    retry(2, 500, (chat_id: number, text: string) =>
      fetch(`${tokenToTelegramURL(token)}sendMessage`, {
        method: "POST",
        headers: { "Content-type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text,
          disable_web_page_preview: true,
          parse_mode: "HTML" as grammy.ParseMode,
        }),
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
      result: grammy.File;
    };
    const imageResponse = await fetch(
      `https://api.telegram.org/file/bot${token}/${file_path}`,
    );
    if (!imageResponse.ok) throw new Error("could not fetch photo");
    return encodeBase64(await imageResponse.arrayBuffer());
  };

const image = (token: string) =>
  pipe(
    max(prop<grammy.PhotoSize>()("width")),
    prop<grammy.PhotoSize>()("file_id"),
    fileIdToContentBase64(token),
  );

const sharedOwnPhone = (
  ownId: number,
  { user_id, phone_number }: grammy.Contact,
) => (user_id === ownId) ? phone_number : undefined;

const contactToFullName = ({ first_name, last_name }: grammy.Contact) =>
  first_name + (last_name ? " " + last_name : "");

export const getBestPhoneFromContactShared = ({
  phone_number,
  vcard,
}: grammy.Contact) => {
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
  { text, entities, contact, photo, caption, from }: grammy.Message,
): Promise<AbstractIncomingMessage> => ({
  text: text +
    (entities ?? []).map((x) => x.type === "text_link" ? x.url : "").filter(
      (x) => x,
    ).join("\n"),
  contact: contact && {
    name: contactToFullName(contact),
    phone: getBestPhoneFromContactShared(contact),
  },
  image: photo && await image(token)(photo),
  caption,
  ownPhone: contact && sharedOwnPhone(coerce(from?.id), contact),
});

export const makeTelegramHandler = (
  telegramToken: string,
  path: string,
  doTask: TaskHandler,
): Endpoint => (
  {
    bounce: true,
    method: "POST",
    path,
    handler: ({ message }: grammy.Update) =>
      message?.from && message.text
        ? pipe(
          abstractMessage(telegramToken),
          letIn(
            {
              id: message.from.id,
              tgm: new Telegraf(telegramToken, { handlerTimeout: Infinity })
                .telegram,
            },
            ({ id, tgm }) =>
              pipe(
                injectUserId(() => id.toString())<TaskHandler>,
                injectFileLimitMB(() => 50)<TaskHandler>,
                injectSendFile(sendFileTelegram(tgm, id))<TaskHandler>,
                injectReply((t: string) =>
                  sendTelegramMessage(telegramToken)(id, t)
                )<TaskHandler>,
                injectProgressBar(telegramProgressBar(tgm, id))<TaskHandler>,
                injectSpinner(makeSpinner(tgm, id))<TaskHandler>,
              )(doTask),
          ),
        )(message)
        : Promise.resolve(),
  }
);
