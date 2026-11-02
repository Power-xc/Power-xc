#!/usr/bin/env node
// 프로필 Featured 카드 GIF 렌더러. 의존성 없이 Chrome DevTools 프로토콜로 장면을 프레임 단위로 찍고 ffmpeg로 묶는다.
// 사용: node tools/featured/render.mjs [scene ...] [--theme light|dark|both] [--fps 12] [--scale 2] [--at 1.5,6]
// 필요: Node 22+, Chrome(CHROME_PATH), ffmpeg(FFMPEG_PATH), Pretendard·JetBrains Mono 설치
import { spawn, execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCENES = path.join(here, "scenes");
const OUT = path.resolve(here, "../../assets/featured");
const FRAMES = path.join(here, ".frames");
const FFMPEG = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const CHROME =
  process.env.CHROME_PATH ||
  path.join(
    homedir(),
    ".cache/puppeteer/chrome/mac_arm-155.0.8059.84/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  );
const BUDGET_MB = 1.5;

const args = process.argv.slice(2);
const opt = { theme: "both", fps: 12, scale: 2, colors: 96, at: null };
const scenes = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) {
    scenes.push(a);
    continue;
  }
  const k = a.slice(2);
  if (!(k in opt)) throw new Error(`알 수 없는 옵션: ${a}`);
  opt[k] = args[++i];
}
for (const k of ["fps", "scale", "colors"]) opt[k] = Number(opt[k]);
if (!["light", "dark", "both"].includes(opt.theme))
  throw new Error("--theme은 light|dark|both");
if (!existsSync(CHROME))
  throw new Error(`Chrome을 찾을 수 없어요: ${CHROME} (CHROME_PATH로 지정)`);
const targets = scenes.length
  ? scenes
  : readdirSync(SCENES)
      .filter((f) => f.endsWith(".html"))
      .map((f) => f.slice(0, -5))
      .sort();
const themes = opt.theme === "both" ? ["light", "dark"] : [opt.theme];

// 헤드리스 Chrome을 띄우고 DevTools 웹소켓 주소를 받는다.
function launch() {
  const profile = mkdtempSync(path.join(tmpdir(), "featured-chrome-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--no-first-run",
      // 쿠키 암호화 키를 macOS 키체인에서 꺼내지 않게 해 암호 창이 뜨지 않는다
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return new Promise((resolve, reject) => {
    let log = "";
    const timer = setTimeout(
      () => reject(new Error(`Chrome이 응답하지 않아요:\n${log}`)),
      30000,
    );
    proc.stderr.on("data", (d) => {
      log += d;
      const m = log.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, profile, ws: m[1] });
      }
    });
    proc.on("exit", (code) =>
      reject(new Error(`Chrome이 종료됐어요(${code}):\n${log}`)),
    );
  });
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const listeners = [];
  let seq = 0;
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error)
        reject(new Error(`${msg.error.message} ${msg.error.data ?? ""}`));
      else resolve(msg.result);
    } else if (msg.method) listeners.forEach((fn) => fn(msg));
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(
        JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }),
      );
    });
  const once = (method, sessionId) =>
    new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.method !== method || msg.sessionId !== sessionId) return;
        listeners.splice(listeners.indexOf(fn), 1);
        resolve(msg.params);
      };
      listeners.push(fn);
    });
  return new Promise((resolve, reject) => {
    ws.onopen = () => resolve({ send, once, close: () => ws.close() });
    ws.onerror = () =>
      reject(new Error(`DevTools에 연결하지 못했어요: ${url}`));
  });
}

async function openScene(cdp, scene, theme) {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const call = (method, params) => cdp.send(method, params, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  const loaded = cdp.once("Page.loadEventFired", sessionId);
  await call("Page.navigate", {
    url:
      pathToFileURL(path.join(SCENES, `${scene}.html`)).href +
      `?theme=${theme}`,
  });
  await loaded;
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        `${scene}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`,
      );
    return r.result.value;
  };
  const meta = await evaluate(
    "document.fonts.ready.then(() => ({ width: CARD.width, height: CARD.height, duration: CARD.duration }))",
  );
  await call("Emulation.setDeviceMetricsOverride", {
    width: meta.width,
    height: meta.height,
    deviceScaleFactor: opt.scale,
    mobile: false,
  });
  const shoot = async (t, file) => {
    await evaluate(`CARD.render(${t})`);
    const { data } = await call("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    writeFileSync(file, Buffer.from(data, "base64"));
  };
  return {
    meta,
    shoot,
    close: () => cdp.send("Target.closeTarget", { targetId }),
  };
}

const rows = [];
const chrome = await launch();
const cdp = await connect(chrome.ws);
try {
  mkdirSync(OUT, { recursive: true });
  for (const scene of targets) {
    for (const theme of themes) {
      const { meta, shoot, close } = await openScene(cdp, scene, theme);
      const dir = path.join(FRAMES, `${scene}-${theme}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      if (opt.at) {
        for (const s of String(opt.at).split(","))
          await shoot(Number(s) * 1000, path.join(dir, `at-${s}.png`));
        console.log(`${scene}-${theme}: ${dir}/at-*.png`);
        await close();
        continue;
      }
      const n = Math.round((meta.duration / 1000) * opt.fps);
      for (let i = 0; i < n; i++)
        await shoot(
          (i * 1000) / opt.fps,
          path.join(dir, `f${String(i).padStart(4, "0")}.png`),
        );
      await close();
      const frames = path.join(dir, "f%04d.png");
      const palette = path.join(dir, "palette.png");
      const gif = path.join(OUT, `${scene}-${theme}.gif`);
      execFileSync(FFMPEG, [
        "-y",
        "-v",
        "error",
        "-framerate",
        String(opt.fps),
        "-i",
        frames,
        "-vf",
        `palettegen=stats_mode=diff:max_colors=${opt.colors}`,
        palette,
      ]);
      execFileSync(FFMPEG, [
        "-y",
        "-v",
        "error",
        "-framerate",
        String(opt.fps),
        "-i",
        frames,
        "-i",
        palette,
        "-lavfi",
        "paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
        "-loop",
        "0",
        gif,
      ]);
      rows.push({
        scene,
        theme,
        frames: n,
        px: `${meta.width * opt.scale}x${meta.height * opt.scale}`,
        mb: statSync(gif).size / 1048576,
      });
    }
  }
} finally {
  cdp.close();
  const exited = new Promise((resolve) => chrome.proc.once("exit", resolve));
  chrome.proc.kill();
  await exited;
  rmSync(chrome.profile, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
}

if (rows.length) {
  console.log("\n| 장면 | 테마 | 프레임 | 픽셀 | 크기(MB) | 예산 |");
  console.log("| --- | --- | ---: | --- | ---: | --- |");
  for (const r of rows)
    console.log(
      `| ${r.scene} | ${r.theme} | ${r.frames} | ${r.px} | ${r.mb.toFixed(2)} | ${r.mb <= BUDGET_MB ? "OK" : `초과(>${BUDGET_MB})`} |`,
    );
}
