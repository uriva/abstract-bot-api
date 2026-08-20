export const makeHeaders = (accessToken: string) => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

export const stripUndefined = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;

const decodeHtmlEntities = (text: string): string =>
  text
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&hellip;/gi, "…")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—")
    .replace(/&(?:lsquo|rsquo|#8216|#8217);/gi, "'")
    .replace(/&(?:ldquo|rdquo|#8220|#8221);/gi, '"')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return code === 160 ? " " : String.fromCodePoint(code);
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return code === 0xa0 ? " " : String.fromCodePoint(code);
    })
    .replace(/&amp;/gi, "&")
    .replace(/\u00A0/g, " ");

const markdownLinkToText = (
  _match: string,
  text: string,
  url: string,
) => text === url ? url : `${text} - ${url}`;

const convertMarkdownToFacebookFormat = (message: string): string =>
  message
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, markdownLinkToText)
    .replace(/^(#{1,6})\s+(.+)$/gm, "*$2*")
    .replace(/\*\*([^*]+)\*\*/g, "*$1*");

export const convertHtmlToFacebookFormat = (message: string): string =>
  convertMarkdownToFacebookFormat(
    decodeHtmlEntities(
      message
        .replace(/<br\s*\/?>(?=)/gi, "\n")
        .replace(/<(?:b|strong)[^>]*>(.*?)<\/(?:b|strong)>/gis, "*$1*")
        .replace(/<(?:i|em)[^>]*>(.*?)<\/(?:i|em)>/gis, "_$1_")
        .replace(/<h[1-6][^>]*>(.*?)<\/h[1-6]>/gis, "*$1*")
        .replace(/<(?:u|ins)[^>]*>(.*?)<\/(?:u|ins)>/gis, "_$1_")
        .replace(/<(?:s|strike|del)[^>]*>(.*?)<\/(?:s|strike|del)>/gis, "~$1~")
        .replace(/<code><pre>(.*?)<\/pre><\/code>/gis, "```$1```")
        .replace(/<pre><code>(.*?)<\/code><\/pre>/gis, "```$1```")
        .replace(/<code[^>]*>(.*?)<\/code>/gis, (_, content) => {
          if (content.includes("\n")) {
            return `\`\`\`${content}\`\`\``;
          }
          return `\`${content}\``;
        })
        .replace(/<pre[^>]*>(.*?)<\/pre>/gis, "```$1```")
        .replace(
          /<\/(div|p|code|pre)>/gi,
          (tag) => tag.includes("code") || tag.includes("pre") ? "" : "\n",
        )
        .replace(/<(div|p)[^>]*>/gi, "")
        .replace(/<span[^>]*>(.*?)<\/span>/gi, "$1")
        .replace(/<ul>([\s\S]*?)<\/ul>/gi, (_m, content: string) => {
          const items = content.match(/<li>([\s\S]*?)<\/li>/gi) || [];
          return items.map((item) =>
            `* ${item.replace(/<\/?li>/gi, "").trim()}`
          )
            .join(
              "\n",
            );
        })
        .replace(/<ol>([\s\S]*?)<\/ol>/gi, (_m, content: string) => {
          const items = content.match(/<li>([\s\S]*?)<\/li>/gi) || [];
          return items.map((item, index) =>
            `${index + 1}. ${item.replace(/<\/?li>/gi, "").trim()}`
          ).join("\n");
        })
        // Handle mailto anchors: show just the email if text equals it, otherwise "text - email"
        .replace(
          /<a\s[^>]*href=[\"'“”](mailto:([^\"'“”\?]+)(?:\?[^\"'“”]*)?)[\"'“”][^>]*>(.*?)<\/a>/gi,
          (_m, _fullMailto: string, email: string, text: string) =>
            text.toLowerCase() === email.toLowerCase()
              ? email
              : `${text} - ${email}`,
        )
        // Support both straight and smart quotes around href attribute
        // Capture full URL in group 1 and the host/path without protocol in group 2
        .replace(
          /<a\s[^>]*href=[\"'“”]((https?:\/\/)([^\"'“”]+))[\"'“”][^>]*>(.*?)<\/a>/gi,
          (
            _m,
            fullUrl: string,
            _protocol: string,
            linkNoProtocol: string,
            text: string,
          ) => {
            const http = `http://${linkNoProtocol}`;
            const https = `https://${linkNoProtocol}`;
            return (text === linkNoProtocol || text === http ||
                text === https || text === fullUrl)
              ? fullUrl
              : `${text} - ${fullUrl}`;
          },
        )
        .replace(/<blockquote>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
          return "\n> " + String(content).trim().replace(/\n/g, "\n> ") + "\n";
        })
        .replace(/<[^>]+>/g, "")
        .trim(),
    ),
  ).replace(/(https?:\/\/[^\s)\]\}]+)([)\]\}]+)/g, "$1 $2");
