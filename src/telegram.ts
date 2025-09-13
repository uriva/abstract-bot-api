import type {
  ApiResponse,
  Contact,
  Message,
  ParseMode,
  PhotoSize,
  Update,
} from "@grammyjs/types";
import { encodeBase64 } from "@std/encoding";
import { coerce, max, pipe, prop, retry, sleep, throttle } from "gamla";
import { get } from "node:https";
import { Readable } from "node:stream";
import { Telegraf, type Telegram } from "telegraf";
import {
  ConversationEvent,
  injectFileLimitMB,
  injectLastEvent,
  injectMedium,
  injectProgressBar,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectTyping,
  injectUserId,
  type TaskHandler,
} from "./api.ts";
import type { Endpoint } from "./index.ts";

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
      (uid: number, path: string) => (path.includes(".gif")
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
    return throttle(1)((progress: number) => {
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

const makeTyping = (tgm: Telegram, uid: number) => () =>
  tgm.sendChatAction(uid, "typing").then(() => {});

const tokenToTelegramURL = (token: string) =>
  `https://api.telegram.org/bot${token}/`;

const streamToChunks = async (stream: NodeJS.ReadableStream) => {
  const chunks: BlobPart[] = [];
  for await (const chunk of stream) {
    if (typeof chunk === "string") {
      chunks.push(chunk);
    } else if (chunk instanceof Uint8Array) {
      // Buffer extends Uint8Array in Node; copy to a plain Uint8Array to satisfy DOM types
      chunks.push(new Uint8Array(chunk));
    } else {
      // Fallback: coerce unknown chunk types into bytes via TextEncoder
      chunks.push(new TextEncoder().encode(String(chunk)));
    }
  }
  return chunks;
};

export const telegramSendFile = (botToken: string) =>
async (
  userId: number,
  stream: NodeJS.ReadableStream,
  filename: string,
): Promise<void> => {
  const body = new FormData();
  body.append("chat_id", String(userId));
  body.append("document", new Blob(await streamToChunks(stream)), filename);
  await fetch(`${tokenToTelegramURL(botToken)}sendDocument`, {
    method: "POST",
    body,
  });
};

type SendPhotoParams = {
  chatId: number;
  stream: NodeJS.ReadableStream;
  fileType: "jpeg" | "png";
  filename: string;
  caption?: string;
};

export const telegramSendPhoto =
  (botToken: string) =>
  async ({ chatId, stream, fileType, filename, caption }: SendPhotoParams) => {
    const body = new FormData();
    body.append("chat_id", String(chatId));
    body.append(
      "photo",
      new Blob(await streamToChunks(stream), { type: `image/${fileType}` }),
      filename,
    );
    if (caption) body.append("caption", caption);
    await fetch(`${tokenToTelegramURL(botToken)}sendPhoto`, {
      method: "POST",
      body,
    });
  };

export const sendTelegramMessage = (token: string) =>
  pipe(
    retry(2, 500, (chat_id: number, text: string) =>
      fetch(`${tokenToTelegramURL(token)}sendMessage`, {
        method: "POST",
        headers: { "Content-type": "application/json" },
        body: JSON.stringify({
          chat_id,
          text: sanitizeTelegramHtml(text),
          disable_web_page_preview: true,
          parse_mode: "HTML" as ParseMode,
        }),
      }).then((r) =>
        r.json()
      )),
    (response: ApiResponse<Message>) => {
      if (response.ok) {
        return response.result.message_id.toString();
      }
      throw new Error(
        `Telegram error: ${response.error_code} ${response.description}`,
      );
    },
  );

// Escape unsafe HTML while preserving a small allowlist of Telegram-supported tags
// so parse_mode: "HTML" won't fail on plain angle brackets like "<ul>" or "<someurl>".
// Allowlist includes tags commonly used in bots: b, strong, i, em, u, s, del, code, pre, and <a href="...">.
export const sanitizeTelegramHtml = (input: string): string => {
  if (!input) return input;
  // First, escape everything that could break HTML parsing
  let out = input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  // Then, selectively unescape allowed tags. We keep attributes only for <a ...> and <pre ...>.
  const simpleTags = [
    "b",
    "strong",
    "i",
    "em",
    "u",
    "s",
    "strike",
    "del",
    "code",
    "pre",
  ];
  for (const tag of simpleTags) {
    const open = new RegExp(`&lt;${tag}&gt;`, "gi");
    const close = new RegExp(`&lt;\/${tag}&gt;`, "gi");
    out = out.replace(open, `<${tag}>`).replace(close, `</${tag}>`);
  }

  // <a href="..."> ... </a>
  out = out
    .replace(/&lt;a\s+href=("[^"]*"|'[^']*')\s*&gt;/gi, "<a href=$1>")
    .replace(/&lt;\/a&gt;/gi, "</a>");

  // Preserve Telegram spoiler spans: <span class="tg-spoiler">
  out = out
    .replace(
      /&lt;span\s+class=("tg-spoiler"|'tg-spoiler')\s*&gt;/gi,
      "<span class=$1>",
    )
    .replace(/&lt;\/span&gt;/gi, "</span>");

  return out;
};

export const setTelegramWebhook = (token: string, url: string) =>
  fetch(`${tokenToTelegramURL(token)}setWebhook?url=${url}`);

const fileIdToContentBase64 =
  (token: string) => async (fileId: string): Promise<string> => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    );
    if (!response.ok) throw new Error("could not fetch photo url");
    const { result: { file_path } } = await response.json();
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

const sharedOwnPhone = (
  ownId: number,
  { user_id, phone_number }: Contact,
) => user_id === ownId ? phone_number : undefined;

const contactToFullName = ({ first_name, last_name }: Contact) =>
  first_name + (last_name ? ` ${last_name}` : "");

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

const toNormalizedEvent = async (
  token: string,
  { text, entities, contact, photo, caption, from }: Message,
): Promise<ConversationEvent> => ({
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

const injectDeps = (telegramToken: string, id: number, tgm: Telegram) =>
  pipe(
    injectMedium(() => "telegram"),
    injectUserId(() => id.toString()),
    injectFileLimitMB(() => 50),
    injectSendFile(sendFileTelegram(tgm, id)),
    injectReply((t: string) =>
      // @ts-ignore error in node but not in deno
      sendTelegramMessage(telegramToken)(id, t)
    ),
    injectProgressBar(telegramProgressBar(tgm, id)),
    injectSpinner(makeSpinner(tgm, id)),
    injectTyping(makeTyping(tgm, id)),
  );

const telegrafInstance = (token: string) =>
  new Telegraf(token, { handlerTimeout: Number.POSITIVE_INFINITY }).telegram;

export const telegramInjectDepsAndRun = (
  telegramToken: string,
  fromId: number,
) => injectDeps(telegramToken, fromId, telegrafInstance(telegramToken));

export const makeTelegramHandler = (
  telegramToken: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<Update> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: async ({ message }: Update) => {
    if (!message) return Promise.resolve();
    const normalizedEvent = await toNormalizedEvent(telegramToken, message);
    return injectLastEvent(() => normalizedEvent)(
      telegramInjectDepsAndRun(telegramToken, message.from.id)(doTask),
    )();
  },
});
