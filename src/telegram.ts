import type {
  ApiResponse,
  Contact,
  Message,
  ParseMode,
  PhotoSize,
  Update,
} from "@grammyjs/types";
import { encodeBase64 } from "@std/encoding";
import type { Injector } from "@uri/inject";
import { coerce, max, pipe, prop, retry, sleep, throttle } from "gamla";
import { get } from "node:https";
import { Readable } from "node:stream";
import { Telegraf, type Telegram } from "telegraf";
import {
  type ConversationEvent,
  injectEditMessage,
  injectFileLimitMB,
  injectLastEvent,
  injectMedium,
  injectProgressBar,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectTyping,
  injectUserId,
  type MediaAttachment,
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
  (tgm: Telegram, uid: number) => (path: string): Promise<void> =>
    retry(
      3000,
      2,
      (uid: number, path: string) => (path.includes(".gif")
        ? tgm.sendAnimation(uid, path)
        : tgm.sendVideo(uid, { source: createUrlReadStream(path) })),
    )(uid, path).then(() => {});

const progressMessage =
  (text: string, progressBarLength: number) => (progress: number) => {
    const completedLength = Math.round(progress * progressBarLength);
    const progressBar = "▓".repeat(completedLength) +
      "░".repeat(progressBarLength - completedLength);
    return `${text} [${progressBar}] ${Math.round(progress * 100)}%`;
  };

const telegramProgressBar =
  (tgm: Telegram, uid: number) =>
  async (text: string): Promise<(progress: number) => Promise<void>> => {
    const bar = progressMessage(text, 20);
    let lastValue = 0;
    const { message_id } = await tgm.sendMessage(uid, bar(lastValue));
    return throttle(1)((progress: number): Promise<void> => {
      if (bar(progress) === bar(lastValue)) return Promise.resolve();
      lastValue = progress;
      return tgm.editMessageText(uid, message_id, undefined, bar(progress))
        .then();
    });
  };

const spinnerMessages = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const makeSpinner =
  (tgm: Telegram, uid: number) =>
  async (text: string): Promise<() => Promise<void>> => {
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

const tokenToTelegramURL = (token: string): string =>
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

export const telegramSendPhoto = (botToken: string) =>
async (
  { chatId, stream, fileType, filename, caption }: SendPhotoParams,
): Promise<void> => {
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

export const sendTelegramMessage = (token: string): (
  chat_id: number,
  text: string,
) => Promise<string> =>
  pipe(
    retry(
      2,
      500,
      (chat_id: number, text: string) =>
        fetch(`${tokenToTelegramURL(token)}sendMessage`, {
          method: "POST",
          headers: { "Content-type": "application/json" },
          body: JSON.stringify({
            chat_id,
            text: sanitizeTelegramHtml(text),
            disable_web_page_preview: true,
            parse_mode: "HTML" as ParseMode,
          }),
        }).then((r) => r.json()),
    ),
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
  // 1) Escape everything first so raw angle brackets don't break parsing
  const escaped = input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

  // 2) Balanced restore for a small allowlist of Telegram-supported tags.
  // Only restore tags if they are properly matched and valid; otherwise keep them escaped.
  type Token =
    | { kind: "text"; value: string }
    | {
      kind: "tag";
      raw: string;
      name: string;
      type: "open" | "close";
      allowedCandidate: boolean;
      restore?: boolean;
      hrefQuoted?: string; // for <a href="...">
      spanSpoiler?: boolean; // for <span class="tg-spoiler">
    };

  const simpleAllowed = new Set([
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
  ]);

  const tagRe = /&lt;(\/)?([a-zA-Z0-9]+)([^&]*?)&gt;/g;

  const tokens: Token[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(escaped))) {
    if (m.index > last) {
      tokens.push({ kind: "text", value: escaped.slice(last, m.index) });
    }
    const isClose = !!m[1];
    const name = m[2].toLowerCase();
    const attr = (m[3] ?? "").trim();
    let allowedCandidate = false;
    let hrefQuoted: string | undefined;
    let spanSpoiler = false;

    if (!isClose) {
      if (simpleAllowed.has(name)) {
        allowedCandidate = attr.length === 0; // no attributes allowed for simple tags
      } else if (name === "a") {
        const hrefMatch = attr.match(/^href=("[^"]*"|'[^']*')$/i);
        if (hrefMatch) {
          allowedCandidate = true;
          hrefQuoted = hrefMatch[1];
        }
      } else if (name === "span") {
        if (/^class=("tg-spoiler"|'tg-spoiler')$/i.test(attr)) {
          allowedCandidate = true;
          spanSpoiler = true;
        }
      }
    } else {
      // closing tags shouldn't have attributes
      if (
        (simpleAllowed.has(name) || name === "a" || name === "span") &&
        attr.length === 0
      ) {
        allowedCandidate = true;
      }
    }

    tokens.push({
      kind: "tag",
      raw: m[0],
      name,
      type: isClose ? "close" : "open",
      allowedCandidate,
      hrefQuoted,
      spanSpoiler,
    });
    last = m.index + m[0].length;
  }
  if (last < escaped.length) {
    tokens.push({ kind: "text", value: escaped.slice(last) });
  }

  // Pass 2: mark balanced pairs to restore using a stack per nesting
  const stack: Array<{ name: string; idx: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "tag" || !t.allowedCandidate) continue;
    if (t.type === "open") {
      stack.push({ name: t.name, idx: i });
    } else {
      // close
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (top && top.name === t.name) {
        // matched pair
        const openTok = tokens[top.idx];
        if (openTok.kind === "tag") openTok.restore = true;
        t.restore = true;
        stack.pop();
      } else {
        // mismatched close - leave escaped
      }
    }
  }

  // Build output restoring only tokens marked restore
  let result = "";
  for (const t of tokens) {
    if (t.kind === "text") {
      result += t.value;
    } else if (t.restore) {
      if (t.type === "open") {
        if (simpleAllowed.has(t.name)) {
          result += `<${t.name}>`;
        } else if (t.name === "a" && t.hrefQuoted) {
          result += `<a href=${t.hrefQuoted}>`;
        } else if (t.name === "span" && t.spanSpoiler) {
          result += `<span class="tg-spoiler">`;
        } else {
          // should not happen; keep escaped raw as fallback
          result += t.raw;
        }
      } else {
        result += `</${t.name}>`;
      }
    } else {
      // keep as escaped
      result += t.raw;
    }
  }

  return result;
};

export const setTelegramWebhook = (
  token: string,
  url: string,
): Promise<Response> =>
  fetch(`${tokenToTelegramURL(token)}setWebhook?url=${url}`);

const getMimeTypeFromExtension = (filePath: string): string => {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  const mimeTypes: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    ogg: "audio/ogg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    pdf: "application/pdf",
    txt: "text/plain",
    zip: "application/zip",
    json: "application/json",
    xml: "application/xml",
    csv: "text/csv",
    doc: "application/msword",
    docx:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  };
  return mimeTypes[ext] || "application/octet-stream";
};

const fileIdToContentBase64AndMime =
  (token: string) =>
  async (fileId: string): Promise<{ dataBase64: string; mimeType: string }> => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    );
    if (!response.ok) throw new Error("could not fetch file url");
    const { result: { file_path } } = await response.json();
    const fileResponse = await fetch(
      `https://api.telegram.org/file/bot${token}/${file_path}`,
    );
    if (!fileResponse.ok) throw new Error("could not fetch file");
    const dataBase64 = encodeBase64(await fileResponse.arrayBuffer());
    return { dataBase64, mimeType: getMimeTypeFromExtension(file_path) };
  };

const photoAttachment = (token: string) =>
async (
  photos: PhotoSize[],
  caption?: string,
): Promise<MediaAttachment> => {
  const largestPhoto = pipe(max(prop<PhotoSize>()("width")))(photos);
  const { dataBase64, mimeType } = await fileIdToContentBase64AndMime(token)(
    largestPhoto.file_id,
  );
  return { kind: "inline", mimeType, dataBase64, caption };
};

const mediaFileAttachment = (token: string) =>
async (
  file: { file_id: string; mime_type?: string },
): Promise<MediaAttachment> => {
  const { dataBase64, mimeType } = await fileIdToContentBase64AndMime(token)(
    file.file_id,
  );
  return {
    kind: "inline",
    mimeType: file.mime_type || mimeType,
    dataBase64,
  };
};

const sharedOwnPhone = (
  ownId: number,
  { user_id, phone_number }: Contact,
) => user_id === ownId ? phone_number : undefined;

const contactToFullName = ({ first_name, last_name }: Contact) =>
  first_name + (last_name ? ` ${last_name}` : "");

export const getBestPhoneFromContactShared = ({
  phone_number,
  vcard,
}: Contact): string => {
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

export const telegramNormalizeEvent = async (
  token: string,
  { text, entities, contact, photo, caption, voice, from, document }: Message,
): Promise<ConversationEvent> => {
  const attachments: MediaAttachment[] = [];
  if (photo) {
    attachments.push(await photoAttachment(token)(photo, caption));
  }
  if (voice) {
    attachments.push(await mediaFileAttachment(token)(voice));
  }
  if (document) {
    attachments.push(await mediaFileAttachment(token)(document));
  }
  return {
    text: text +
      (entities ?? []).map((x) => x.type === "text_link" ? x.url : "").filter(
        (x) => x,
      ).join("\n"),
    contact: contact && {
      name: contactToFullName(contact),
      phone: getBestPhoneFromContactShared(contact),
    },
    attachments,
    ownPhone: contact && sharedOwnPhone(coerce(from?.id), contact),
  };
};

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
    injectEditMessage((msgId: string, text: string) =>
      tgm.editMessageText(
        id,
        Number(msgId),
        undefined,
        sanitizeTelegramHtml(text),
      )
        .then(() => {})
    ),
    injectProgressBar(telegramProgressBar(tgm, id)),
    injectSpinner(makeSpinner(tgm, id)),
    injectTyping(makeTyping(tgm, id)),
  );

const telegrafInstance = (token: string) =>
  new Telegraf(token, { handlerTimeout: Number.POSITIVE_INFINITY }).telegram;

export const telegramInjectDeps = (
  telegramToken: string,
  fromId: number,
): Injector =>
  injectDeps(telegramToken, fromId, telegrafInstance(telegramToken));

export const makeTelegramHandler = (
  telegramToken: string,
  path: string,
  doTask: TaskHandler,
): Endpoint<Update> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  handler: async (update: Update) => {
    const message = update.message ?? update.edited_message;
    if (!message) return Promise.resolve();
    const normalizedEvent = await telegramNormalizeEvent(
      telegramToken,
      message,
    );
    const event = update.edited_message
      ? { ...normalizedEvent, editedMessageId: message.message_id.toString() }
      : normalizedEvent;
    return pipe(
      telegramInjectDeps(telegramToken, message.from.id),
      injectLastEvent(() => event),
    )(doTask)();
  },
});
