import { assertEquals } from "@std/assert";
import { convertToWhatsAppFormat } from "./whatsapp.ts";

Deno.test("convertToWhatsAppFormat basic formatting", () => {
  const input = "<b>Bold</b> and <u>Under</u><br>Line";
  const expected = "*Bold* and _Under_\nLine";
  assertEquals(convertToWhatsAppFormat(input), expected);
});

Deno.test("convertToWhatsAppFormat link dedupe when text equals link", () => {
  const input = '<a href="https://example.com">https://example.com</a>';
  const expected = "example.com";
  assertEquals(convertToWhatsAppFormat(input), expected);
});

Deno.test("convertToWhatsAppFormat link with different text", () => {
  const input = '<a href="https://example.com">Example</a>';
  const expected = "Example - example.com";
  assertEquals(convertToWhatsAppFormat(input), expected);
});

Deno.test("convertToWhatsAppFormat link where text equals hostname only", () => {
  const input = '<a href="https://example.com">example.com</a>';
  const expected = "example.com";
  assertEquals(convertToWhatsAppFormat(input), expected);
});
