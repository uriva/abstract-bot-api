import type {
  ApiResponse,
  Contact,
  Message,
  ParseMode,
  PhotoSize,
  Update,
} from "@grammyjs/types";

import type { Injector } from "@uri/inject";
import { coerce, max, pipe, prop, retry, sleep, throttle } from "gamla";
import { Readable } from "node:stream";
import { Telegraf, type Telegram } from "telegraf";
import {
  type ConversationEvent,
  injectDeleteMessage,
  injectEditMessage,
  injectFileLimitMB,
  injectLastEvent,
  injectMedium,
  injectProgressBar,
  injectQuotedReply,
  injectReaction,
  injectReply,
  injectSendFile,
  injectSpinner,
  injectTyping,
  injectUserId,
  type MediaAttachment,
  type TaskHandler,
} from "./api.ts";
import type { Endpoint } from "./index.ts";
import { verifyTelegramSecretToken } from "./webhookAuth.ts";

const createUrlReadStream = async (url: string): Promise<Readable> => {
  const response = await fetch(url);
  return Readable.fromWeb(
    response.body as import("node:stream/web").ReadableStream,
  );
};

const ignoreKick = (err: unknown) => {
  const e = err as Error & { response?: { error_code?: number } };
  if (
    e?.response?.error_code === 403 ||
    e?.message?.includes("PEER_ID_INVALID") ||
    e?.message?.includes("bot was kicked") ||
    e?.message?.includes("Forbidden")
  ) {
    console.warn(`Ignoring Telegram error: ${e.message}`);
    return undefined;
  }
  throw e;
};

export const sendFileTelegram =
  (tgm: Telegram, uid: number) => (path: string): Promise<void> =>
    retry(
      3000,
      2,
      async (uid: number, path: string) => (path.includes(".gif")
        ? tgm.sendAnimation(uid, path).catch(ignoreKick)
        : tgm.sendVideo(uid, { source: await createUrlReadStream(path) }).catch(
          ignoreKick,
        )),
    )(uid, path).then(() => {});

const progressMessage =
  (text: string, progressBarLength: number) => (progress: number) => {
    const completedLength = Math.round(progress * progressBarLength);
    const progressBar = "▓".repeat(completedLength) +
      "░".repeat(progressBarLength - completedLength);
    return `${text} [${progressBar}] ${Math.round(progress * 100)}%`;
  };

const telegramProgressBar =
  (tgm: Telegram, uid: number, onMessageId?: (id: number) => void) =>
  async (text: string): Promise<(progress: number) => Promise<void>> => {
    const bar = progressMessage(text, 20);
    let lastValue = 0;
    const message_id = await tgm.sendMessage(uid, bar(lastValue)).then((r) =>
      r?.message_id
    ).catch(ignoreKick);
    if (message_id) onMessageId?.(message_id);
    return throttle(1)((progress: number): Promise<void> => {
      if (!message_id || bar(progress) === bar(lastValue)) {
        return Promise.resolve();
      }
      lastValue = progress;
      return tgm.editMessageText(uid, message_id, undefined, bar(progress))
        .then(() => {}).catch(ignoreKick);
    });
  };

const spinnerMessages = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const makeSpinner =
  (tgm: Telegram, uid: number, onMessageId?: (id: number) => void) =>
  async (text: string): Promise<() => Promise<void>> => {
    const messageId = await tgm.sendMessage(
      uid,
      `${text} ${spinnerMessages[0]}`,
    ).then((r) => r?.message_id).catch(ignoreKick);
    if (messageId) onMessageId?.(messageId);
    let finished = false;
    const update = async (frame: number): Promise<void> => {
      if (!messageId || finished) return;
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
        .then(() => {}).catch(ignoreKick);
    };
  };

const makeTyping = (tgm: Telegram, uid: number) => () =>
  tgm.sendChatAction(uid, "typing").then(() => {}).catch(ignoreKick);

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
(chat_id: number, text: string) => {
  const normalized = telegramMessageText(text);
  if (!normalized) return Promise.resolve("");
  return pipe(
    retry(
      2,
      500,
      (chat_id: number, text: string) =>
        fetch(`${tokenToTelegramURL(token)}sendMessage`, {
          method: "POST",
          headers: { "Content-type": "application/json" },
          body: JSON.stringify({
            chat_id,
            text,
            disable_web_page_preview: true,
            parse_mode: "HTML" as ParseMode,
          }),
        }).then((r) => r.json()),
    ),
    (response: ApiResponse<Message>) => {
      if (response.ok) return response.result.message_id.toString();
      if (
        response.error_code === 403 ||
        response.description.includes("PEER_ID_INVALID") ||
        response.description.includes("bot was kicked")
      ) {
        console.warn(
          `Ignoring Telegram error: ${response.error_code} ${response.description}`,
        );
        return "";
      }
      throw new Error(
        `Telegram error: ${response.error_code} ${response.description}`,
      );
    },
  )(chat_id, normalized);
};

const telegramMessageText = (text: string) =>
  sanitizeTelegramHtml(markdownToTelegramHtml(text)).trim();

const sendTelegramMessageIfNonempty =
  (send: (chatId: number, text: string) => Promise<string>) =>
  (chatId: number, text: string) => {
    const normalized = telegramMessageText(text);
    return normalized ? send(chatId, normalized) : Promise.resolve("");
  };

export const sendTelegramQuotedReply = (token: string) =>
(
  chat_id: number,
  text: string,
  replyToMessageId: string,
): Promise<string> =>
  pipe(
    (normalized: string) =>
      normalized
        ? fetch(`${tokenToTelegramURL(token)}sendMessage`, {
          method: "POST",
          headers: { "Content-type": "application/json" },
          body: JSON.stringify({
            chat_id,
            text: normalized,
            disable_web_page_preview: true,
            parse_mode: "HTML" as ParseMode,
            reply_parameters: { message_id: Number(replyToMessageId) },
          }),
        }).then((r) => r.json()).then((response: ApiResponse<Message>) => {
          if (response.ok) return response.result.message_id.toString();
          if (
            response.error_code === 403 ||
            response.description.includes("PEER_ID_INVALID") ||
            response.description.includes("bot was kicked")
          ) {
            console.warn(
              `Ignoring Telegram error: ${response.error_code} ${response.description}`,
            );
            return "";
          }
          throw new Error(
            `Telegram error: ${response.error_code} ${response.description}`,
          );
        })
        : Promise.resolve(""),
  )(telegramMessageText(text));

const convertMarkdownSegment = (text: string): string =>
  text
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>")
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(?<!\w)\*([^*\n]+)\*(?!\w)/g, "<i>$1</i>")
    .replace(/~~(.+?)~~/g, "<s>$1</s>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const processOutsideInlineCode = (segment: string): string => {
  const parts = segment.split(/(`[^`\n]+`)/);
  return parts
    .map((part) =>
      part.startsWith("`") && part.endsWith("`")
        ? `<code>${part.slice(1, -1)}</code>`
        : convertMarkdownSegment(part)
    )
    .join("");
};

export const markdownToTelegramHtml = (text: string): string => {
  const parts = text.split(/(```(?:\w*)\n?[\s\S]*?```)/);
  return parts
    .map((part) => {
      const codeMatch = part.match(/^```(?:\w*)\n?([\s\S]*?)```$/);
      return codeMatch
        ? `<pre>${codeMatch[1].trimEnd()}</pre>`
        : processOutsideInlineCode(part);
    })
    .join("");
};

export const sanitizeTelegramHtml = (input: string): string => {
  if (!input) return input;
  // 0) Decode pre-existing HTML entities to prevent double-escaping
  const decoded = input
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
  // 1) Escape everything first so raw angle brackets don't break parsing
  const escaped = decoded
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

  const tagRe = /&lt;(\/)?([a-zA-Z0-9]+)((?:[^&]|&(?!gt;|lt;))*?)&gt;/g;

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
  secretToken?: string,
): Promise<Response> =>
  fetch(
    `${tokenToTelegramURL(token)}setWebhook?url=${url}` +
      (secretToken ? `&secret_token=${encodeURIComponent(secretToken)}` : ""),
  );

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

const fileIdToUrlAndMime =
  (token: string) =>
  async (fileId: string): Promise<{ fileUri: string; mimeType: string }> => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`,
    );
    if (!response.ok) throw new Error("could not fetch file url");
    const { result: { file_path } } = await response.json();
    return {
      fileUri: `https://api.telegram.org/file/bot${token}/${file_path}`,
      mimeType: getMimeTypeFromExtension(file_path),
    };
  };

const photoAttachment = (token: string) =>
async (
  photos: PhotoSize[],
  caption?: string,
): Promise<MediaAttachment> => {
  const largestPhoto = pipe(max(prop<PhotoSize>()("width")))(photos);
  const { fileUri, mimeType } = await fileIdToUrlAndMime(token)(
    largestPhoto.file_id,
  );
  return { kind: "file", mimeType, fileUri, caption };
};

const mediaFileAttachment = (token: string) =>
async (
  file: { file_id: string; mime_type?: string },
): Promise<MediaAttachment> => {
  const { fileUri, mimeType } = await fileIdToUrlAndMime(token)(
    file.file_id,
  );
  return {
    kind: "file",
    mimeType: file.mime_type || mimeType,
    fileUri,
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
  {
    text,
    entities,
    contact,
    photo,
    caption,
    voice,
    from,
    document,
    location,
    reply_to_message,
    message_id,
  }: Message,
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
  const locationText = location
    ? `https://maps.google.com/maps?q=${location.latitude},${location.longitude}`
    : "";
  const textWithLinks = (text ?? "") +
    (entities ?? []).map((x) => x.type === "text_link" ? x.url : "").filter(
      (x) => x,
    ).join("\n");
  return {
    kind: "message",
    id: message_id.toString(),
    text: [textWithLinks, locationText].filter((x) => x).join("\n"),
    contact: contact && {
      name: contactToFullName(contact),
      phone: getBestPhoneFromContactShared(contact),
    },
    attachments,
    ownPhone: contact && sharedOwnPhone(coerce(from?.id), contact),
    ...(reply_to_message
      ? { referencedMessageId: reply_to_message.message_id.toString() }
      : {}),
  };
};

const videoTagRegex =
  /<video[^>]*(?:\ssrc=["']([^"']+)["'])[^>]*>(?:<\/video>)?|<video[^>]*>\s*<source\s+[^>]*src=["']([^"']+)["'][^>]*\/?>(?:\s*<\/source>)?\s*<\/video>/i;

const joinRemainingParts = (before: string, after: string) =>
  before + (before && after ? "\n" : "") + after;

const buildResult = (
  text: string,
  matchIndex: number,
  matchLength: number,
  videoUrl: string,
) => ({
  videoUrl,
  remainingText: joinRemainingParts(
    text.slice(0, matchIndex).trim(),
    text.slice(matchIndex + matchLength).trim(),
  ),
});

export const extractVideoTag = (
  text: string,
): { videoUrl: string; remainingText: string } | null => {
  const match = videoTagRegex.exec(text);
  if (!match) return null;
  const videoUrl = match[1] ?? match[2];
  if (!videoUrl) return null;
  return buildResult(text, match.index, match[0].length, videoUrl);
};

const imgTagRegex = /<img[^>]*\ssrc=["']([^"']+)["'][^>]*\/?>/i;

const buildImgResult = (
  text: string,
  matchIndex: number,
  matchLength: number,
  imageUrl: string,
) => ({
  imageUrl,
  remainingText: joinRemainingParts(
    text.slice(0, matchIndex).trim(),
    text.slice(matchIndex + matchLength).trim(),
  ),
});

export const extractImgTag = (
  text: string,
): { imageUrl: string; remainingText: string } | null => {
  const match = imgTagRegex.exec(text);
  if (!match) return null;
  const imageUrl = match[1];
  if (!imageUrl) return null;
  return buildImgResult(text, match.index, match[0].length, imageUrl);
};

const injectDeps = (
  telegramToken: string,
  id: number,
  tgm: Telegram,
  onSpinnerMessageId?: (id: number) => void,
  onProgressBarMessageId?: (id: number) => void,
) =>
  pipe(
    injectMedium(() => "telegram"),
    injectUserId(() => id.toString()),
    injectFileLimitMB(() => 50),
    injectSendFile(sendFileTelegram(tgm, id)),
    injectReply(async (t: string) => {
      const extractedVideo = extractVideoTag(t);
      if (extractedVideo) {
        await sendFileTelegram(tgm, id)(extractedVideo.videoUrl);
        return extractedVideo.remainingText
          // @ts-ignore error in node but not in deno
          ? sendTelegramMessageIfNonempty(sendTelegramMessage(telegramToken))(
            id,
            extractedVideo.remainingText,
          )
          : crypto.randomUUID();
      }
      const extractedImg = extractImgTag(t);
      if (extractedImg) {
        await tgm.sendPhoto(id, extractedImg.imageUrl).catch(ignoreKick);
        return extractedImg.remainingText
          // @ts-ignore error in node but not in deno
          ? sendTelegramMessageIfNonempty(sendTelegramMessage(telegramToken))(
            id,
            extractedImg.remainingText,
          )
          : crypto.randomUUID();
      }
      // @ts-ignore error in node but not in deno
      return sendTelegramMessageIfNonempty(sendTelegramMessage(telegramToken))(
        id,
        t,
      );
    }),
    injectEditMessage((msgId: string, text: string) =>
      Promise.resolve(telegramMessageText(text)).then((normalized) =>
        normalized
          ? tgm.editMessageText(
            id,
            Number(msgId),
            undefined,
            normalized,
            { parse_mode: "HTML" as ParseMode },
          ).then(() => {}).catch(ignoreKick)
          : undefined
      )
    ),
    injectProgressBar(telegramProgressBar(tgm, id, onProgressBarMessageId)),
    injectSpinner(makeSpinner(tgm, id, onSpinnerMessageId)),
    injectTyping(makeTyping(tgm, id)),
    injectReaction((msgId: string, emoji: string) =>
      fetch(`https://api.telegram.org/bot${telegramToken}/setMessageReaction`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: id,
          message_id: Number(msgId),
          reaction: [{ type: "emoji", emoji }],
        }),
      }).then(() => {}).catch(ignoreKick)
    ),
    injectDeleteMessage((chatId: string, msgId: string) =>
      fetch(`https://api.telegram.org/bot${telegramToken}/deleteMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, message_id: Number(msgId) }),
      }).then(() => {}).catch(() => {})
    ),
    injectQuotedReply((text: string, replyToMessageId: string) =>
      sendTelegramQuotedReply(telegramToken)(id, text, replyToMessageId)
    ),
  );

const telegrafInstance = (token: string) =>
  new Telegraf(token, { handlerTimeout: Number.POSITIVE_INFINITY }).telegram;

export const telegramInjectDeps = (
  telegramToken: string,
  fromId: number,
  onSpinnerMessageId?: (id: number) => void,
  onProgressBarMessageId?: (id: number) => void,
): Injector =>
  injectDeps(
    telegramToken,
    fromId,
    telegrafInstance(telegramToken),
    onSpinnerMessageId,
    onProgressBarMessageId,
  );

export const makeTelegramHandler = (
  telegramToken: string,
  path: string,
  doTask: TaskHandler,
  secretToken: string,
): Endpoint<Update> => ({
  bounce: true,
  predicate: ({ url, method }) => url === path && method === "POST",
  authenticate: ({ headers }) =>
    verifyTelegramSecretToken(secretToken, headers),
  handler: async (update: Update) => {
    if (update.message_reaction) {
      const { message_reaction } = update;
      const first = message_reaction.new_reaction[0];
      const emoji = first?.type === "emoji" ? first.emoji : "";
      if (!emoji) return Promise.resolve();
      const event: ConversationEvent = {
        kind: "reaction",
        id: message_reaction.message_id.toString(),
        reaction: emoji,
        onMessageId: message_reaction.message_id.toString(),
      };
      return pipe(
        telegramInjectDeps(
          telegramToken,
          message_reaction.user?.id ?? message_reaction.chat.id,
        ),
        injectLastEvent(() => event),
      )(doTask)();
    }
    const message = update.message ?? update.edited_message;
    if (!message) return Promise.resolve();
    const normalized = await telegramNormalizeEvent(telegramToken, message);
    const event: ConversationEvent =
      update.edited_message && normalized.kind === "message"
        ? {
          kind: "edit",
          id: message.message_id.toString(),
          text: normalized.text ?? "",
          onMessageId: message.message_id.toString(),
          attachments: normalized.attachments,
        }
        : normalized;
    return pipe(
      telegramInjectDeps(telegramToken, message.from.id),
      injectLastEvent(() => event),
    )(doTask)();
  },
});
