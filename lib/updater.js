/**
 * 检查更新 + 热更新——查 pika-show-remote-client 这个公开镜像仓库的最新 Release
 * （build-remote-client.yml 构建、CI 里自动建 Release，见该 workflow 注释），
 * 比对版本号，有新版就下载替换自己重启。
 *
 * "运行中的 exe 不能覆盖自己"是 Windows 的老问题：pkg 打出来的单文件 exe 没有
 * Electron 那种成熟的 autoUpdater，只能自己写替换逻辑——标准做法是拉起一个
 * 独立的 helper（这里用 cmd /c 的一段命令，不用额外落一个 .bat 文件）等本进程
 * 退出后再做"move 新文件到位 + 重新拉起"，本进程自己退出触发这一步。
 */

const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn } = require("child_process");
const pkgJson = require("../package.json");

const REPO = "Tekoljw/pika-show-remote-client";
const CURRENT_VERSION = pkgJson.version;

function parseVersion(v) {
  return String(v || "").replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
}

/** a > b 返回 true */
function isNewer(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** @returns {Promise<{hasUpdate:boolean, latestVersion:string, currentVersion:string, downloadUrl?:string, error?:string}>} */
async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "pika-show-remote-client", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) return { hasUpdate: false, currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, error: `GitHub 返回 ${res.status}` };
    const release = await res.json();
    const latestVersion = release.tag_name || "";
    const asset = (release.assets || []).find((a) => a.name.endsWith(".exe"));
    const hasUpdate = !!asset && isNewer(latestVersion, CURRENT_VERSION);
    return {
      hasUpdate,
      currentVersion: CURRENT_VERSION,
      latestVersion: latestVersion || CURRENT_VERSION,
      downloadUrl: asset?.browser_download_url,
    };
  } catch (e) {
    return { hasUpdate: false, currentVersion: CURRENT_VERSION, latestVersion: CURRENT_VERSION, error: e.message };
  }
}

/**
 * 下载新版本、替换当前 exe、重启——只在真正是 pkg 打包的 exe 时才有意义
 * （process.pkg 存在时 process.execPath 就是这个 exe 自己的路径；源码直跑时
 * execPath 是 node.exe，不该被替换，直接报错拒绝）。
 */
async function applyUpdate(downloadUrl, onProgress) {
  if (!process.pkg) throw new Error("源码直跑模式不支持自动更新，改用 npm run build:win 打包成 exe 后再更新");
  if (!downloadUrl) throw new Error("缺少下载地址");

  const currentExePath = process.execPath;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pika-show-update-"));
  const newExePath = path.join(tmpDir, "pika-show-remote-new.exe");

  onProgress?.("正在下载新版本...");
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`下载失败: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(newExePath, buf);
  onProgress?.(`下载完成(${(buf.length / 1024 / 1024).toFixed(1)}MB)，准备重启替换`);

  // helper：等本进程退出（PID 从任务列表消失）再把新文件挪到位、重新拉起。
  // /nobreak + find 循环轮询而不是 taskkill /wait 之类——不依赖额外工具，
  // cmd.exe 自带命令就够。
  const pid = process.pid;
  const helperCmd =
    `@echo off\r\n` +
    `:wait\r\n` +
    `tasklist /FI "PID eq ${pid}" 2>NUL | find "${pid}" >NUL\r\n` +
    `if not errorlevel 1 (\r\n` +
    `  timeout /t 1 /nobreak >nul\r\n` +
    `  goto wait\r\n` +
    `)\r\n` +
    `move /y "${newExePath}" "${currentExePath}" >NUL\r\n` +
    `start "" "${currentExePath}"\r\n` +
    `del "%~f0"\r\n`;
  const helperPath = path.join(tmpDir, "apply-update.bat");
  fs.writeFileSync(helperPath, helperCmd);

  spawn("cmd.exe", ["/c", helperPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  onProgress?.("正在重启...");
  setTimeout(() => process.exit(0), 300);
}

module.exports = { checkForUpdate, applyUpdate, CURRENT_VERSION };
