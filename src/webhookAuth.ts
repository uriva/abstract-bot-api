import { createRemoteJWKSet, jwtVerify } from "jose";
import type { IncomingHttpHeaders } from "node:http";

const encoder = new TextEncoder();

const getHeader = (
  headers: IncomingHttpHeaders,
  name: string,
): string | undefined => {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let index = 0; index < a.length; index++) {
    result |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return result === 0;
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacSha256Hex = async (
  secret: string,
  value: string,
): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(value),
  );
  return bytesToHex(new Uint8Array(signature));
};

export const verifySlackSignature = async (
  signingSecret: string,
  headers: IncomingHttpHeaders,
  rawBody: string | undefined,
): Promise<boolean> => {
  const signature = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  if (!signature || !timestamp || !rawBody) return false;
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - timestampSeconds) > 300) {
    return false;
  }
  const expected = `v0=${await hmacSha256Hex(
    signingSecret,
    `v0:${timestamp}:${rawBody}`,
  )}`;
  return timingSafeEqual(expected, signature);
};

export const verifyMetaSignature = async (
  appSecret: string,
  headers: IncomingHttpHeaders,
  rawBody: string | undefined,
): Promise<boolean> => {
  const signature = getHeader(headers, "x-hub-signature-256");
  if (!signature || !rawBody) return false;
  const expected = `sha256=${await hmacSha256Hex(appSecret, rawBody)}`;
  return timingSafeEqual(expected, signature);
};

export const verifyTelegramSecretToken = (
  expectedSecretToken: string,
  headers: IncomingHttpHeaders,
): boolean => {
  const secretToken = getHeader(headers, "x-telegram-bot-api-secret-token");
  return !!secretToken && timingSafeEqual(secretToken, expectedSecretToken);
};

export const verifyAuthorizationHeader = (
  expectedAuthorizationHeader: string,
  headers: IncomingHttpHeaders,
): boolean => {
  const authorization = getHeader(headers, "authorization");
  return !!authorization &&
    timingSafeEqual(authorization, expectedAuthorizationHeader);
};

const botFrameworkJwks = createRemoteJWKSet(
  new URL("https://login.botframework.com/v1/.well-known/keys"),
);

export const verifyBotFrameworkJwt = async (
  appId: string,
  serviceUrl: string | undefined,
  headers: IncomingHttpHeaders,
): Promise<boolean> => {
  const authorization = getHeader(headers, "authorization");
  if (!authorization?.startsWith("Bearer ") || !serviceUrl) return false;
  const token = authorization.slice("Bearer ".length);
  const { payload } = await jwtVerify(token, botFrameworkJwks, {
    issuer: "https://api.botframework.com",
    audience: appId,
  });
  const tokenServiceUrl = payload.serviceUrl ?? payload.serviceurl;
  return typeof tokenServiceUrl === "string" &&
    timingSafeEqual(tokenServiceUrl, serviceUrl);
};
