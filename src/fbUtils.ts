export const makeHeaders = (accessToken: string) => ({
  "Authorization": `Bearer ${accessToken}`,
  "Content-Type": "application/json",
});

export const stripUndefined = <T extends Record<string, unknown>>(obj: T): T =>
  Object.fromEntries(
    Object.entries(obj).filter(([, value]) => value !== undefined),
  ) as T;

export const convertHtmlToFacebookFormat = (message: string): string =>
  message
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<b>(.*?)<\/b>/gi, "*$1*")
    .replace(/<h[1-6]>(.*?)<\/h[1-6]>/gi, "*$1*")
    .replace(/<u>(.*?)<\/u>/gi, "_$1_")
    .replace(/<\/(div|p)>/gi, "\n")
    .replace(/<(div|p)[^>]*>/gi, "")
    .replace(/<span[^>]*>(.*?)<\/span>/gi, "$1")
    .replace(/<ul>([\s\S]*?)<\/ul>/gi, (_m, content: string) => {
      const items = content.match(/<li>([\s\S]*?)<\/li>/gi) || [];
      return items.map((item) => `* ${item.replace(/<\/?li>/gi, "").trim()}`)
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
      /<a\s+href=[\"'""](mailto:([^\"'""\?]+)(?:\?[^\"'""]*)?)[\"'""]>(.*?)<\/a>/gi,
      (_m, _fullMailto: string, email: string, text: string) =>
        text.toLowerCase() === email.toLowerCase()
          ? email
          : `${text} - ${email}`,
    )
    // Support both straight and smart quotes around href attribute
    // Capture full URL in group 1 and the host/path without protocol in group 2
    .replace(
      /<a\s+href=[\"'""](https?:\/\/([^\"'""]+))[\"'""]>(.*?)<\/a>/gi,
      (_m, _fullUrl: string, linkNoProtocol: string, text: string) => {
        const http = `http://${linkNoProtocol}`;
        const https = `https://${linkNoProtocol}`;
        return (text === linkNoProtocol || text === http || text === https)
          ? linkNoProtocol
          : `${text} - ${linkNoProtocol}`;
      },
    )
    .trim();
