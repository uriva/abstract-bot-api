import type { Server } from "node:http";
import { assertEquals } from "https://deno.land/std@0.192.0/testing/asserts.ts";
import { bouncerServer, staticFileEndpoint } from "./taskBouncer.ts";

Deno.test("init", async () => {
    const server = await bouncerServer("http://localhost", "1234", []);
    server.close();
});

Deno.test("static endpoint", async () => {
    const fileText = "<div>hello</div>";
    const host = "http://localhost";
    const port = "1234";
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

import axios from "npm:axios";
Deno.test("cors", async () => {
    const host = "http://localhost";
    const port = "1234";
    const url = `${host}:${port}`;
    const { promise: handlerRan, resolve: onHandlerRan } = Promise
        .withResolvers<void>();
    const server = await bouncerServer(url, port, [{
        bounce: true,
        predicate: () => true,
        handler: () => {
            onHandlerRan();
            return Promise.resolve();
        },
    }]);
    // We are using axois here because it closes the connection, otherwise the test hangs.
    const response = await axios.get(`${url}/hello`, {
        headers: { "Origin": "http://example.com" },
    });
    assertEquals(response.headers["access-control-allow-origin"], "*");
    await handlerRan;
    await closeServer(server);
});

Deno.test("cors preflight", async () => {
    const host = "http://localhost";
    const port = "1234";
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
