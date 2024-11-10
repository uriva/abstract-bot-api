import { bouncerServer, staticFileEndpoint } from "./taskBouncer.ts";

Deno.test("init", async () => {
    const server = await bouncerServer("http://localhost", "1234", []);
    server.close();
});

Deno.test("static endpoint", async () => {
    const server = await bouncerServer("http://localhost", "1234", [
        staticFileEndpoint("<div>hello</div>", "text/html", "/hello"),
    ]);
    server.close();
});
