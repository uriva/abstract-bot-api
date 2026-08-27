import { assertEquals } from "@std/assert";
import {
  convertHtmlTablesToPre,
  convertHtmlToTelegramFormat,
  extractImgTag,
  extractVideoTag,
  getBestPhoneFromContactShared,
  markdownToTelegramHtml,
  sanitizeTelegramHtml,
  sendTelegramMessage,
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

Deno.test("sendTelegramMessage skips empty text after normalization", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
    );
  };

  try {
    const result = await sendTelegramMessage("token")(123, "   ");
    assertEquals(result, "");
    assertEquals(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("convertHtmlTablesToPre formats HTML table to ASCII inside pre", () => {
  const input = `Here is the pricing:
<table>
  <thead>
    <tr>
      <th style="color: blue">Tool</th>
      <th>Price</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>dFlux d3x</td>
      <td>Custom</td>
    </tr>
    <tr>
      <td>Spirent</td>
      <td>$100k+</td>
    </tr>
  </tbody>
</table>`;

  const res = convertHtmlTablesToPre(input);

  const expected = `Here is the pricing:
<pre>Tool      | Price \n----------+-------\ndFlux d3x | Custom\nSpirent   | $100k+</pre>`;

  assertEquals(res, expected);
});

Deno.test("convertHtmlToTelegramFormat converts h1-h6 to bold", () => {
  assertEquals(
    convertHtmlToTelegramFormat("<h3>Heading 3</h3>"),
    "<b>Heading 3</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<h1>Heading 1</h1>"),
    "<b>Heading 1</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<h2>Heading 2</h2>"),
    "<b>Heading 2</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<h4>Heading 4</h4>"),
    "<b>Heading 4</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<h5>Heading 5</h5>"),
    "<b>Heading 5</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<h6>Heading 6</h6>"),
    "<b>Heading 6</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat(
      '<h3 class="title" id="sec1">Heading with attrs</h3>',
    ),
    "<b>Heading with attrs</b>",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<H3>Case Insensitive</H3>"),
    "<b>Case Insensitive</b>",
  );
});

Deno.test("convertHtmlToTelegramFormat converts line breaks and paragraphs", () => {
  assertEquals(
    convertHtmlToTelegramFormat("Line 1<br>Line 2<br/>Line 3<br />Line 4"),
    "Line 1\nLine 2\nLine 3\nLine 4",
  );
  assertEquals(
    convertHtmlToTelegramFormat("<p>Paragraph 1</p><p>Paragraph 2</p>"),
    "Paragraph 1\nParagraph 2\n",
  );
});

Deno.test("convertHtmlToTelegramFormat converts lists", () => {
  const ulInput = "<ul><li>Item A</li><li>Item B</li></ul>";
  assertEquals(convertHtmlToTelegramFormat(ulInput), "• Item A\n• Item B");

  const olInput = "<ol><li>First</li><li>Second</li></ol>";
  assertEquals(convertHtmlToTelegramFormat(olInput), "1. First\n2. Second");
});

Deno.test("convertHtmlToTelegramFormat strips unneeded span and container tags", () => {
  assertEquals(
    convertHtmlToTelegramFormat('<span style="color:red">styled text</span>'),
    "styled text",
  );
  assertEquals(
    convertHtmlToTelegramFormat('<span class="tg-spoiler">spoiler text</span>'),
    "<tg-spoiler>spoiler text</tg-spoiler>",
  );
  assertEquals(
    convertHtmlToTelegramFormat(
      "<center><font color='blue'>Centered font</font></center>",
    ),
    "Centered font",
  );
});

Deno.test("markdownToTelegramHtml + sanitizeTelegramHtml converts h3 and HTML tags end-to-end", () => {
  const input =
    "<h3>Team Overview</h3>\n<p>Here are the details:</p>\n<ul><li>Alice</li><li>Bob</li></ul>";
  const result = sanitizeTelegramHtml(markdownToTelegramHtml(input));
  assertEquals(
    result,
    "<b>Team Overview</b>\nHere are the details:\n\n• Alice\n• Bob",
  );
});

Deno.test("markdownToTelegramHtml does not convert HTML inside code blocks", () => {
  const input = "```html\n<h3>Do Not Convert</h3>\n```\n<h3>Do Convert</h3>";
  const result = sanitizeTelegramHtml(markdownToTelegramHtml(input));
  assertEquals(
    result,
    "<pre>&lt;h3&gt;Do Not Convert&lt;/h3&gt;</pre>\n<b>Do Convert</b>",
  );
});

Deno.test("markdownToTelegramHtml does not convert HTML inside inline code", () => {
  const input = "Use `<h3>` for headers, and <h3>My Title</h3> for section";
  const result = sanitizeTelegramHtml(markdownToTelegramHtml(input));
  assertEquals(
    result,
    "Use <code>&lt;h3&gt;</code> for headers, and <b>My Title</b> for section",
  );
});

Deno.test("sanitizeTelegramHtml preserves blockquote and expandable blockquote", () => {
  assertEquals(
    sanitizeTelegramHtml("<blockquote>Simple quote</blockquote>"),
    "<blockquote>Simple quote</blockquote>",
  );
  assertEquals(
    sanitizeTelegramHtml(
      "<blockquote expandable>Expandable quote</blockquote>",
    ),
    "<blockquote expandable>Expandable quote</blockquote>",
  );
});
