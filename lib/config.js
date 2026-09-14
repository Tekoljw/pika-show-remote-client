/**
 * 本地配置——2026-09-14 起不再存 device_token（服务端去持久化，每次连接都要
 * 重新走验证码流程，没有"记住我"，见 engine.js 头部注释）。这个文件现在只
 * 存 outputPatches 这一份真正需要跨进程重启保留的本地状态。
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

const CONFIG_DIR = path.join(os.homedir(), ".pika-show-remote");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

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

module.exports = { getMacAddress, load, save, CONFIG_DIR };
