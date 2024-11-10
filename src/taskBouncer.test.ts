import { bouncerServer } from "./taskBouncer.ts";

Deno.test("init", async () => {
    const server = await bouncerServer("http://localhost", "1234", []);
    server.close();
});
