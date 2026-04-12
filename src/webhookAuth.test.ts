import { assert, assertEquals } from "@std/assert";
import {
  verifyAuthorizationHeader,
  verifyMetaSignature,
  verifySlackSignature,
  verifyTelegramSecretToken,
} from "./webhookAuth.ts";

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacSha256Hex = async (
  secret: string,
  value: string,
): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return hex(new Uint8Array(signature));
};

Deno.test("verifySlackSignature accepts valid signature", async () => {
  const rawBody = JSON.stringify({ type: "url_verification" });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = `v0=${await hmacSha256Hex(
    "slack-secret",
    `v0:${timestamp}:${rawBody}`,
  )}`;

  assert(
    await verifySlackSignature("slack-secret", {
      "x-slack-signature": signature,
      "x-slack-request-timestamp": timestamp,
    }, rawBody),
  );
});

Deno.test("verifyMetaSignature accepts valid signature", async () => {
  const rawBody = JSON.stringify({ object: "page" });
  const signature = `sha256=${await hmacSha256Hex("meta-secret", rawBody)}`;
  assert(
    await verifyMetaSignature("meta-secret", {
      "x-hub-signature-256": signature,
    }, rawBody),
  );
});

Deno.test("verifyTelegramSecretToken matches exact header", () => {
  assert(
    verifyTelegramSecretToken("telegram-secret", {
      "x-telegram-bot-api-secret-token": "telegram-secret",
    }),
  );
});

Deno.test("verifyAuthorizationHeader matches exact header", () => {
  assert(
    verifyAuthorizationHeader("Bearer green-secret", {
      authorization: "Bearer green-secret",
    }),
  );
  assertEquals(
    verifyAuthorizationHeader("Bearer green-secret", {
      authorization: "Bearer wrong",
    }),
    false,
  );
});
