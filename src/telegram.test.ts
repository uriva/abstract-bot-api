import { assertEquals } from "@std/assert";
import {
  extractVideoTag,
  getBestPhoneFromContactShared,
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
