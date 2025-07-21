import { build, emptyDir } from "jsr:@deno/dnt";
import { gamla } from "./deps.ts";

const outDir = "./dist";

await emptyDir(outDir);

await build({
  entryPoints: ["./src/index.ts"],
  outDir,
  shims: { deno: true },
  package: {
    name: "abstract-bot-api",
    version: gamla.coerce(Deno.args[0]),
    description: "",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/uriva/abstract-bot-api.git",
    },
    bugs: { url: "https://github.com/uriva/abstract-bot-api/issues" },
    devDependencies: { "@types/ws": "^8.5.10", "@types/sjcl": "^1.0.34" },
  },
  importMap: "deno.json",
  postBuild() {
    Deno.copyFileSync("./LICENSE", `${outDir}/LICENSE`);
    Deno.copyFileSync("./README.md", `${outDir}/README.md`);
  },
});
