import { assertEquals } from "@std/assert";
import { convertHtmlToFacebookFormat } from "./fbUtils.ts";

Deno.test("convertHtmlToFacebookFormat handles line breaks", () => {
  const input = "Line 1<br>Line 2<br/>Line 3";
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "Line 1\nLine 2\nLine 3");
});

Deno.test("convertHtmlToFacebookFormat handles bold and underline", () => {
  const input = "<b>bold text</b> and <u>underlined</u>";
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "*bold text* and _underlined_");
});

Deno.test("convertHtmlToFacebookFormat handles email links", () => {
  const input = '<a href="mailto:test@example.com">test@example.com</a>';
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "test@example.com");
});

Deno.test("convertHtmlToFacebookFormat handles email links with different text", () => {
  const input = '<a href="mailto:test@example.com">Email Me</a>';
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "Email Me - test@example.com");
});

Deno.test("convertHtmlToFacebookFormat handles web links", () => {
  const input = '<a href="https://example.com">example.com</a>';
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "example.com");
});

Deno.test("convertHtmlToFacebookFormat handles web links with different text", () => {
  const input = '<a href="https://example.com">Click Here</a>';
  const out = convertHtmlToFacebookFormat(input);
  assertEquals(out, "Click Here - example.com");
});

Deno.test("convertHtmlToFacebookFormat link dedupe when text equals link", () => {
  const input = '<a href="https://example.com">https://example.com</a>';
  const expected = "example.com";
  assertEquals(convertHtmlToFacebookFormat(input), expected);
});

Deno.test("convertHtmlToFacebookFormat link where text equals hostname only", () => {
  const input = '<a href="https://example.com">example.com</a>';
  const expected = "example.com";
  assertEquals(convertHtmlToFacebookFormat(input), expected);
});

Deno.test("convertHtmlToFacebookFormat preserves smart quotes outside links and handles them in href", () => {
  const curly =
    "<a href=“https://example.com”>“Fancy” link</a><br>and ‘quotes’";
  const expected = "“Fancy” link - example.com\nand ‘quotes’";
  assertEquals(convertHtmlToFacebookFormat(curly), expected);
});
