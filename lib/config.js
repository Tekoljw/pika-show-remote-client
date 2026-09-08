/**
 * 本地配置——配对成功后拿到的 device_token 存在这里，下次启动直接用它自动
 * 认证，不用重新走一遍验证码流程。跟原来 Python 版 agent-client 的
 * ~/.claude-agent/config.json 是同一个思路，换成 PIKA-Show 自己的目录。
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
    return { device_token: null, server_host: "show.pika.club", server_port: 443 };
  }
}

function save(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

module.exports = { getMacAddress, load, save, CONFIG_DIR };
