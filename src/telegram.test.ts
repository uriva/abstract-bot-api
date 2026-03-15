import { assertEquals } from "@std/assert";
import {
  extractImgTag,
  extractVideoTag,
  getBestPhoneFromContactShared,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
} from "./telegram.ts";

const alicePhone = "972521111111";

Deno.test("parse vcard", () => {
  assertEquals(
    getBestPhoneFromContactShared({
      phone_number: "+97236746666",
      first_name: "Alice",
      last_name: "Smith",
      vcard: `BEGIN:VCARD
VERSION:2.1
N:Smith;Alice;;;
FN:Alice Smith
EMAIL;PREF:alice@gmail.com
EMAIL:alice@mail.huji.ac.il
EMAIL:alice@google.com
TEL;CELL;PREF:+${alicePhone}
TEL;HOME:+97236746666
END:VCARD`,
    }),
    `+${alicePhone}`,
  );
});

Deno.test("sanitizeTelegramHtml escapes raw angle brackets", () => {
  const input = "Check this <someurl> and <ul>";
  const out = sanitizeTelegramHtml(input);
  assertEquals(out, "Check this &lt;someurl&gt; and &lt;ul&gt;");
});

Deno.test("sanitizeTelegramHtml preserves allowed tags", () => {
  const input = "<b>bold</b> and <i>italic</i> plus <code>x<y</code>";
  const out = sanitizeTelegramHtml(input);
  // inner <y should be escaped, but surrounding tags restored
  assertEquals(out, "<b>bold</b> and <i>italic</i> plus <code>x&lt;y</code>");
});

Deno.test("sanitizeTelegramHtml preserves anchors", () => {
  const input = 'Click <a href="https://example.com">here</a> and <foo>';
  const out = sanitizeTelegramHtml(input);
  assertEquals(
    out,
    'Click <a href="https://example.com">here</a> and &lt;foo&gt;',
  );
});

Deno.test("sanitizeTelegramHtml preserves anchors with query params", () => {
  const input =
    '<a href="https://view-chat.com/conversations?groupId=41037a5d-ce63-4616-8f5c-b5b1ab688b02&conversationName=229336330&limit=1">view chat</a>';
  const out = sanitizeTelegramHtml(input);
  assertEquals(
    out,
    '<a href="https://view-chat.com/conversations?groupId=41037a5d-ce63-4616-8f5c-b5b1ab688b02&amp;conversationName=229336330&amp;limit=1">view chat</a>',
  );
});

Deno.test("sanitizeTelegramHtml escapes unbalanced <b> opening tag", () => {
  const input = "<b>hello"; // missing closing </b>
  const out = sanitizeTelegramHtml(input);
  // Expected to escape since it's unbalanced, otherwise Telegram HTML will fail
  assertEquals(out, "&lt;b&gt;hello");
});

Deno.test("sanitizeTelegramHtml escapes unbalanced </b> closing tag", () => {
  const input = "hello</b>"; // missing opening <b>
  const out = sanitizeTelegramHtml(input);
  assertEquals(out, "hello&lt;/b&gt;");
});

Deno.test("extractVideoTag returns null for text without video tag", () => {
  assertEquals(extractVideoTag("just some text"), null);
});

Deno.test("extractVideoTag extracts src from video tag", () => {
  const result = extractVideoTag(
    'Here is your video: <video src="https://example.com/video.mp4"></video>',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/video.mp4",
    remainingText: "Here is your video:",
  });
});

Deno.test("extractVideoTag handles self-closing video tag", () => {
  const result = extractVideoTag(
    '<video src="https://example.com/video.mp4">',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/video.mp4",
    remainingText: "",
  });
});

Deno.test("extractVideoTag handles video tag with surrounding text", () => {
  const result = extractVideoTag(
    'Before <video src="https://example.com/v.mp4"></video> after',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/v.mp4",
    remainingText: "Before\nafter",
  });
});

Deno.test("extractVideoTag handles video tag with single quotes", () => {
  const result = extractVideoTag(
    "<video src='https://example.com/v.mp4'>",
  );
  assertEquals(result, {
    videoUrl: "https://example.com/v.mp4",
    remainingText: "",
  });
});

Deno.test("extractVideoTag handles video tag with extra attributes", () => {
  const result = extractVideoTag(
    '<video controls src="https://example.com/v.mp4" width="640"></video>',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/v.mp4",
    remainingText: "",
  });
});

Deno.test("extractVideoTag handles source child element", () => {
  const result = extractVideoTag(
    '<video controls><source src="https://example.com/v.mp4" type="video/mp4" /></video>',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/v.mp4",
    remainingText: "",
  });
});

Deno.test("extractVideoTag handles source child with surrounding text", () => {
  const result = extractVideoTag(
    'Here it is: <video controls><source src="https://example.com/v.mp4" type="video/mp4" /></video> enjoy!',
  );
  assertEquals(result, {
    videoUrl: "https://example.com/v.mp4",
    remainingText: "Here it is:\nenjoy!",
  });
});

Deno.test("extractImgTag returns null for text without img tag", () => {
  assertEquals(extractImgTag("just some text"), null);
});

Deno.test("extractImgTag extracts src from img tag", () => {
  const result = extractImgTag(
    'Here is your image: <img src="https://example.com/photo.jpg">',
  );
  assertEquals(result, {
    imageUrl: "https://example.com/photo.jpg",
    remainingText: "Here is your image:",
  });
});

Deno.test("extractImgTag handles self-closing img tag", () => {
  const result = extractImgTag(
    '<img src="https://example.com/photo.jpg" />',
  );
  assertEquals(result, {
    imageUrl: "https://example.com/photo.jpg",
    remainingText: "",
  });
});

Deno.test("extractImgTag handles img tag with surrounding text", () => {
  const result = extractImgTag(
    'Before <img src="https://example.com/photo.jpg"> after',
  );
  assertEquals(result, {
    imageUrl: "https://example.com/photo.jpg",
    remainingText: "Before\nafter",
  });
});

Deno.test("extractImgTag handles img tag with single quotes", () => {
  const result = extractImgTag(
    "<img src='https://example.com/photo.jpg'>",
  );
  assertEquals(result, {
    imageUrl: "https://example.com/photo.jpg",
    remainingText: "",
  });
});

Deno.test("extractImgTag handles img tag with extra attributes", () => {
  const result = extractImgTag(
    '<img alt="A photo" src="https://example.com/photo.jpg" width="640">',
  );
  assertEquals(result, {
    imageUrl: "https://example.com/photo.jpg",
    remainingText: "",
  });
});

Deno.test("markdownToTelegramHtml converts bold", () => {
  assertEquals(markdownToTelegramHtml("hello **world**"), "hello <b>world</b>");
});

Deno.test("markdownToTelegramHtml converts italic", () => {
  assertEquals(markdownToTelegramHtml("hello *world*"), "hello <i>world</i>");
});

Deno.test("markdownToTelegramHtml converts bold italic", () => {
  assertEquals(
    markdownToTelegramHtml("***important***"),
    "<b><i>important</i></b>",
  );
});

Deno.test("markdownToTelegramHtml converts headers to bold", () => {
  assertEquals(markdownToTelegramHtml("### Heading"), "<b>Heading</b>");
  assertEquals(markdownToTelegramHtml("# Title"), "<b>Title</b>");
});

Deno.test("markdownToTelegramHtml converts inline code", () => {
  assertEquals(
    markdownToTelegramHtml("use `deno run`"),
    "use <code>deno run</code>",
  );
});

Deno.test("markdownToTelegramHtml converts code blocks", () => {
  assertEquals(
    markdownToTelegramHtml("```\nconst x = 1;\n```"),
    "<pre>const x = 1;</pre>",
  );
});

Deno.test("markdownToTelegramHtml converts links", () => {
  assertEquals(
    markdownToTelegramHtml("[click](https://example.com)"),
    '<a href="https://example.com">click</a>',
  );
});

Deno.test("markdownToTelegramHtml converts strikethrough", () => {
  assertEquals(markdownToTelegramHtml("~~old~~"), "<s>old</s>");
});

Deno.test("markdownToTelegramHtml does not convert markdown inside code", () => {
  assertEquals(
    markdownToTelegramHtml("`**not bold**`"),
    "<code>**not bold**</code>",
  );
});

Deno.test("markdownToTelegramHtml handles mixed formatting", () => {
  const input = "### Menu\n\n**Ramen** - *delicious*\n~~sold out~~";
  const expected =
    "<b>Menu</b>\n\n<b>Ramen</b> - <i>delicious</i>\n<s>sold out</s>";
  assertEquals(markdownToTelegramHtml(input), expected);
});

Deno.test("markdownToTelegramHtml + sanitizeTelegramHtml end-to-end", () => {
  const input = "### Title\n**bold** and *italic*";
  const result = sanitizeTelegramHtml(markdownToTelegramHtml(input));
  assertEquals(result, "<b>Title</b>\n<b>bold</b> and <i>italic</i>");
});
