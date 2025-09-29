import { assertEquals } from "@std/assert";
import {
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
