import { writeFile } from "node:fs/promises";
import en from "./en.mjs";
import pl from "./pl.mjs";

await writeFile(new URL("./en.json", import.meta.url), JSON.stringify(en, null, 2) + "\n");
await writeFile(new URL("./pl.json", import.meta.url), JSON.stringify(pl, null, 2) + "\n");
console.log("content json synced");
