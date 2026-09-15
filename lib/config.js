/**
 * 本地配置——2026-09-15 起改成存密钥（取代验证码人工配对流程，见
 * engine.js 头部注释和项目记忆 reference_pc_key_auth.md）：用户把 bot 私聊
 * 发来的密钥粘贴进 GUI 一次，之后自动连接、断线自动重连，不用每次重新输入。
 * 加上 outputPatches 这份原本就有的本地状态。
 *
 * 密钥单独存一个文件（key.dat），不放进 config.json——内容是 Windows DPAPI
 * （CryptProtectData）加密后的密文，只有"这台机器 + 当前这个 Windows 用户
 * 账号"这个组合能解开，文件被复制到别的电脑、或被同一台机器的另一个系统
 * 账号读取，拿到的都是解不开的密文，跟 Chrome/Edge 保存密码是同一套机制。
 * 没有走"写死一个对称密钥做 AES"这条路——那样解密的钥匙也在这个公开发布的
 * exe 里，等于没加密。Node 没带 DPAPI，用 child_process 调一小段 PowerShell
 * 现算，不新增原生二进制依赖（避免又给 pkg 打包添一个 prebuild 资产的麻烦），
 * 只在启动读取和保存那两个时刻各调一次，开销可以忽略。
 *
 * outputPatches（{ dmx？: {plugin,line,lineName}, midi？: {...} }，按连接方式
 * 分 key，不是单个对象）：人工在 QLC+ 网页配置界面给每一路 Universe 选好的
 * 真实输出接口，从 qlcEngine.js 的 readOutputPatch() 读回来存在这里——2026-09-13
 * 实测确认 QLC+ 不会在"加载一份没写 <Output> 标签的新配接方案"时继续沿用
 * 之前的选择（会被重置成"无输出"），所以这个必须由我们自己记住、每次生成
 * 配接方案都显式带上，不能依赖 QLC+ 自己记忆，见 engine.js 的 buildWorkspaceXml
 * 调用点。分 key 是因为 MIDI 转接口和 DMX-USB 转接器是两个不同的物理设备，
 * 各自一路 Universe、各自的输出配置，见 qxwGenerator.js 的 CONNECTION_UNIVERSE_ID。
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const CONFIG_DIR = path.join(os.homedir(), ".pika-show-remote");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const KEY_FILE = path.join(CONFIG_DIR, "key.dat");

function dpapiProtect(plainText) {
  const script =
    "[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Protect(" +
    "[System.Text.Encoding]::UTF8.GetBytes($env:PIKA_DPAPI_PLAINTEXT), $null, " +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PIKA_DPAPI_PLAINTEXT: plainText },
    windowsHide: true,
  }).toString("utf8").trim();
}

function dpapiUnprotect(cipherBase64) {
  const script =
    "[System.Text.Encoding]::UTF8.GetString([System.Security.Cryptography.ProtectedData]::Unprotect(" +
    "[Convert]::FromBase64String($env:PIKA_DPAPI_CIPHERTEXT), $null, " +
    "[System.Security.Cryptography.DataProtectionScope]::CurrentUser))";
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, PIKA_DPAPI_CIPHERTEXT: cipherBase64 },
    windowsHide: true,
  }).toString("utf8").trim();
}

/** 读本地存的密钥，解不开（换过电脑/账号、文件损坏、没装过）统一返回 null。 */
function getKey() {
  try {
    const cipher = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (!cipher) return null;
    return dpapiUnprotect(cipher) || null;
  } catch {
    return null;
  }
}

function setKey(key) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, dpapiProtect(String(key || "")));
}

/** 密钥被服务端判定失效（吊销/格式不对）后清掉本地这份，逼 GUI 重新要用户输入。 */
function clearKey() {
  try { fs.unlinkSync(KEY_FILE); } catch {}
}

function getMacAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== "00:00:00:00:00:00") {
        return iface.mac.toUpperCase();
      }
    }
  }
  return "00:00:00:00:00:00";
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return { server_host: "show.pika.club", server_port: 443 };
  }
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

module.exports = { getMacAddress, load, save, getKey, setKey, clearKey, CONFIG_DIR };
