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
    .replace(/<u>(.*?)<\/u>/gi, "_$1_")
    // Handle mailto anchors: show just the email if text equals it, otherwise "text - email"
    .replace(
      /<a\s+href=[\"'“”](mailto:([^\"'“”\?]+)(?:\?[^\"'“”]*)?)[\"'“”]>(.*?)<\/a>/gi,
      (_m, _fullMailto: string, email: string, text: string) =>
        text.toLowerCase() === email.toLowerCase()
          ? email
          : `${text} - ${email}`,
    )
    // Support both straight and smart quotes around href attribute
    // Capture full URL in group 1 and the host/path without protocol in group 2
    .replace(
      /<a\s+href=[\"'“”](https?:\/\/([^\"'“”]+))[\"'“”]>(.*?)<\/a>/gi,
      (_m, _fullUrl: string, linkNoProtocol: string, text: string) => {
        const http = `http://${linkNoProtocol}`;
        const https = `https://${linkNoProtocol}`;
        return (text === linkNoProtocol || text === http || text === https)
          ? linkNoProtocol
          : `${text} - ${linkNoProtocol}`;
      },
    );
