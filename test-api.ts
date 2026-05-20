import * as api from "./src/index.ts";
console.log(Object.keys(api).filter((k) => k.toLowerCase().includes("github")));
