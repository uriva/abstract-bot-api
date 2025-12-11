import { assertEquals } from "@std/assert";
import { each } from "gamla";
import { convertHtmlToFacebookFormat } from "./fbUtils.ts";

const testCases = [
  {
    testName: "handles line breaks",
    input: "Line 1<br>Line 2<br/>Line 3",
    output: "Line 1\nLine 2\nLine 3",
  },
  {
    testName: "handles bold and underline",
    input: "<b>bold text</b> and <u>underlined</u>",
    output: "*bold text* and _underlined_",
  },
  {
    testName: "handles email links",
    input: '<a href="mailto:test@example.com">test@example.com</a>',
    output: "test@example.com",
  },
  {
    testName: "handles email links with different text",
    input: '<a href="mailto:test@example.com">Email Me</a>',
    output: "Email Me - test@example.com",
  },
  {
    testName: "handles web links",
    input: '<a href="https://example.com">example.com</a>',
    output: "example.com",
  },
  {
    testName: "handles web links with different text",
    input: '<a href="https://example.com">Click Here</a>',
    output: "Click Here - example.com",
  },
  {
    testName: "link dedupe when text equals link",
    input: '<a href="https://example.com">https://example.com</a>',
    output: "example.com",
  },
  {
    testName: "link where text equals hostname only",
    input: '<a href="https://example.com">example.com</a>',
    output: "example.com",
  },
  {
    testName: "preserves smart quotes outside links and handles them in href",
    input: '<a href="https://example.com">"Fancy" link</a><br>and \'quotes\'',
    output: "\"Fancy\" link - example.com\nand 'quotes'",
  },
  {
    testName: "handles unordered lists",
    input: "<ul><li>First item</li><li>Second item</li></ul>",
    output: "* First item\n* Second item",
  },
  {
    testName: "handles ordered lists",
    input: "<ol><li>First step</li><li>Second step</li></ol>",
    output: "1. First step\n2. Second step",
  },
  {
    testName: "handles span tags",
    input: "<span>Some text</span> and more",
    output: "Some text and more",
  },
  {
    testName: "handles unordered lists with Hebrew",
    input: "<ul><li>פריט ראשון</li><li>פריט שני</li></ul>",
    output: "* פריט ראשון\n* פריט שני",
  },
  {
    testName: "handles h3 tags",
    input: "<h3>Header 3</h3>",
    output: "*Header 3*",
  },
];

each(({ testName, input, output }) =>
  Deno.test(`convertHtmlToFacebookFormat ${testName}`, () => {
    assertEquals(convertHtmlToFacebookFormat(input), output);
  })
)(testCases);
