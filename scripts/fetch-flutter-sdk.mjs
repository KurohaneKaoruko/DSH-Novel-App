// scripts/fetch-flutter-sdk.mjs — 从中国镜像下载 Flutter stable SDK zip（node fetch 通道）。
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const mirrors = [
  "https://storage.flutter-io.cn/flutter_infra_release/releases/",
  "https://storage.googleapis.com/flutter_infra_release/releases/",
];
const out = process.argv[2] || "flutter-sdk.zip";

for (const base of mirrors) {
  try {
    const relRes = await fetch(base + "releases_windows.json");
    if (!relRes.ok) throw new Error("releases json " + relRes.status);
    const json = await relRes.json();
    const hash = json.current_release.stable;
    const rel = json.releases.find((r) => r.hash === hash);
    if (!rel) throw new Error("stable release not found");
    console.log("stable:", rel.version, "channel:", rel.channel);
    const url = base + rel.archive;
    console.log("downloading:", url);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error("archive " + res.status);
    const total = Number(res.headers.get("content-length") || 0);
    let seen = 0;
    const body = Readable.fromWeb(res.body);
    body.on("data", (c) => {
      seen += c.length;
      if (total && (seen % (20 * 1024 * 1024)) < c.length) {
        process.stdout.write("  " + (seen / 1048576).toFixed(1) + " / " + (total / 1048576).toFixed(1) + " MB\n");
      }
    });
    await pipeline(body, fs.createWriteStream(out));
    const size = fs.statSync(out).size;
    console.log("saved:", out, (size / 1048576).toFixed(1) + " MB");
    console.log("VERSION=" + rel.version);
    process.exit(0);
  } catch (err) {
    console.log("mirror failed (" + base + "):", err.message);
  }
}
process.exit(1);
