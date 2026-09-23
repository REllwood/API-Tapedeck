import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const files = [];
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) visit(child);
    else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) files.push(child);
  }
}
for (const root of ["src", "public", "test", "scripts"]) visit(root);
for (const file of files.sort()) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
execFileSync(process.execPath, ["--test"], { stdio: "inherit" });
