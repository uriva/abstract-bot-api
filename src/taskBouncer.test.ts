import { assertEquals } from "@std/assert";
import type { Server } from "node:http";
import { bouncerServer, staticFileEndpoint } from "./taskBouncer.ts";

let currentPort = 1234;
const getDistinctPortNumber = () => {
  return (currentPort++).toString();
};

Deno.test("init", async () => {
  const server = await bouncerServer(
    "http://localhost",
    getDistinctPortNumber(),
    [],
  );
  await closeServer(server);
});

Deno.test("static endpoint", async () => {
  const fileText = "<div>hello</div>";
  const host = "http://localhost";
  const port = getDistinctPortNumber();
  const server = await bouncerServer(host, port, [
    staticFileEndpoint(fileText, "text/html", "/hello"),
  ]);
  const x = await fetch(`${host}:${port}/hello`);
  assertEquals(await x.text(), fileText);
  await closeServer(server);
});

const closeServer = (server: Server) =>
  new Promise<void>((resolve, reject) => {
    server.close((err) => {
      if (err) reject(err);
      resolve();
    });
  });

// https://github.com/denoland/dnt/issues/440
const promiseWithResolver = () => {
  const obj = {};
  // @ts-expect-error no typing
  obj.promise = new Promise<void>((resolve) => {
    // @ts-expect-error no typing
    obj.resolve = resolve;
  });
  return obj as { promise: Promise<void>; resolve: () => void };
};

Deno.test("cors", async () => {
  const host = "http://localhost";
  const port = getDistinctPortNumber();
  const url = `${host}:${port}`;
  const { promise: handlerRan, resolve: onHandlerRan } = promiseWithResolver();
  const server = await bouncerServer(url, port, [{
    bounce: true,
    predicate: () => true,
    handler: () => {
      onHandlerRan();
      return Promise.resolve();
    },
  }]);
  const response = await fetch(`${url}/hello`, {
    headers: { "Origin": "http://example.com" },
  });
  assertEquals(response.headers.get("access-control-allow-origin"), "*");
  await response.body?.cancel();
  await handlerRan;
  await closeServer(server);
});

Deno.test("cors preflight", async () => {
  const host = "http://localhost";
  const port = getDistinctPortNumber();
  const server = await bouncerServer(host, port, [{
    bounce: true,
    predicate: () => true,
    handler: () => Promise.resolve(),
  }]);
  const { status, headers } = await fetch(`${host}:${port}/hello`, {
    method: "OPTIONS",
    headers: {
      "Origin": "http://example.com",
      "Access-Control-Request-Method": "POST",
    },
  });
  assertEquals(status, 204);
  assertEquals(headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  await closeServer(server);
});
