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
    server.close();
});
