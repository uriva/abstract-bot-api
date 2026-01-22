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
    testName: "handles italic",
    input: "<i>italic text</i>",
    output: "_italic text_",
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
  {
    testName: "handles unordered lists with newlines",
    input: "<ul>\n<li>Item 1</li>\n<li>Item 2</li>\n</ul>",
    output: "* Item 1\n* Item 2",
  },
  {
    testName: "handles p tags",
    input: "<p>Para 1</p><p>Para 2</p>",
    output: "Para 1\nPara 2",
  },
  {
    testName: "handles div tags",
    input: "<div>Div 1</div><div>Div 2</div>",
    output: "Div 1\nDiv 2",
  },
  {
    testName: "handles code tags",
    input: "Use <code>const x = 5;</code> for constants",
    output: "Use `const x = 5;` for constants",
  },
  {
    testName: "handles pre tags",
    input: "<pre>function hello() { return 'world'; }</pre>",
    output: "```function hello() { return 'world'; }```",
  },
  {
    testName: "handles code with script tags and entities",
    input:
      '<code>&lt;script type="application/json"&gt;\ndata\n&lt;/script&gt;</code>',
    output: '```<script type="application/json">\ndata\n</script>```',
  },
  {
    testName: "handles full Rachel bot widget code",
    input:
      '<code>&lt;script type="application/json" id="alice-and-bot-params"&gt;\n  {"participants":["DUMMY_PUBLIC_KEY_DO_NOT_USE"],"requesterId":"1234567890@c.us"}\n&lt;/script&gt;\n&lt;script&gt;\n  const widgetParams = JSON.parse(document.getElementById(\'alice-and-bot-params\').textContent);\n  const s = document.createElement(\'script\');\n  s.src = "https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js";\n  s.async = true;\n  s.onload = () =&gt; aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n&lt;/script&gt;</code>',
    output:
      '```<script type="application/json" id="alice-and-bot-params">\n  {"participants":["DUMMY_PUBLIC_KEY_DO_NOT_USE"],"requesterId":"1234567890@c.us"}\n</script>\n<script>\n  const widgetParams = JSON.parse(document.getElementById(\'alice-and-bot-params\').textContent);\n  const s = document.createElement(\'script\');\n  s.src = "https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js";\n  s.async = true;\n  s.onload = () => aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n</script>```',
  },
  {
    testName: "message with code block and entities",
    input:
      'Here is the HTML snippet for your bot, *Rachel*. You can paste this into the *&lt;head&gt;* section of your website:\n\n<code>&lt;script type="application/json" id="alice-and-bot-params"&gt;\n  {"participants":["DUMMY_KEY"],"requesterId":"1234567890@c.us"}\n&lt;/script&gt;</code>',
    output:
      'Here is the HTML snippet for your bot, *Rachel*. You can paste this into the *<head>* section of your website:\n\n```<script type="application/json" id="alice-and-bot-params">\n  {"participants":["DUMMY_KEY"],"requesterId":"1234567890@c.us"}\n</script>```',
  },
  {
    testName: "handles code wrapping pre tags",
    input:
      "<code><pre>&lt;script&gt;function test() { return 42; }&lt;/script&gt;</pre></code>",
    output: "```<script>function test() { return 42; }</script>```",
  },
  {
    testName: "handles script tags with JSON and widget code",
    input:
      "<code>&lt;script type=&quot;application/json&quot; id=&quot;alice-and-bot-params&quot;&gt;\n  {bla:1}\n&lt;/script&gt;\n&lt;script&gt;\n  const widgetParams = JSON.parse(document.getElementById('alice-and-bot-params').textContent);\n  const s = document.createElement('script');\n  s.src = &quot;https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js&quot;;\n  s.async = true;\n  s.onload = () =&gt; aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n&lt;/script&gt;</code>",
    output:
      '```<script type="application/json" id="alice-and-bot-params">\n  {bla:1}\n</script>\n<script>\n  const widgetParams = JSON.parse(document.getElementById(\'alice-and-bot-params\').textContent);\n  const s = document.createElement(\'script\');\n  s.src = "https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js";\n  s.async = true;\n  s.onload = () => aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n</script>```',
  },
  {
    testName: "handles pre>code wrapping with script tags",
    input:
      "<pre><code>&lt;script type=&quot;application/json&quot; id=&quot;alice-and-bot-params&quot;&gt;\n  {bla:1}\n&lt;/script&gt;\n&lt;script&gt;\n  const widgetParams = JSON.parse(document.getElementById('alice-and-bot-params').textContent);\n  const s = document.createElement('script');\n  s.src = &quot;https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js&quot;;\n  s.async = true;\n  s.onload = () =&gt; aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n&lt;/script&gt;</code></pre>",
    output:
      '```<script type="application/json" id="alice-and-bot-params">\n  {bla:1}\n</script>\n<script>\n  const widgetParams = JSON.parse(document.getElementById(\'alice-and-bot-params\').textContent);\n  const s = document.createElement(\'script\');\n  s.src = "https://storage.googleapis.com/alice-and-bot/widget/dist/widget.iife.js";\n  s.async = true;\n  s.onload = () => aliceAndBot.loadChatWidget(widgetParams);\n  document.head.appendChild(s);\n</script>```',
  },
];

each(({ testName, input, output }) =>
  Deno.test(`convertHtmlToFacebookFormat ${testName}`, () => {
    assertEquals(convertHtmlToFacebookFormat(input), output);
  })
)(testCases);
