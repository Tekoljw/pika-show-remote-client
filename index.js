/**
 * PIKA-Show 远程客户端——装在直播间那台 Windows 电脑上跑的程序。
 *
 * 只支持 Windows，不做跨平台——这是产品定位决定的（现场那台灯控电脑就是
 * Windows），没必要为了"理论上能跨平台"多花工夫，see start.bat。
 *
 * 三件事：
 * 1. 主动连出去到 PIKA-Show 服务端的 /agent（不需要开放任何入站端口，
 *    协议原样照抄 bot/lib/agent-server.js 的定义，兼容原来 Python 版 agent-client）
 * 2. 本地拉起一个无头 QLC+ 子进程当灯光执行引擎（lib/qlcEngine.js）
 * 3. 响应服务端下发的命令：通用 shell 执行（排障用，不限制用途）、
 *    读写本地灯光库、扫描 MIDI/串口设备
 *
 * 环境变量：
 *   PIKA_SHOW_HOST   服务端域名，默认 show.pika.club
 *   QLCPLUS_BIN      qlcplus.exe 完整路径，默认从 PATH 里找 "qlcplus.exe"
 *   QLCPLUS_PORT     QLC+ 内建 Web API 监听端口，默认 9999
 *   QLCPLUS_WORKSPACE 要自动加载的配接方案文件（.qxw），可选
 */

const WebSocket = require("ws");
const { exec } = require("child_process");
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const config = require("./lib/config");
const { readLightMemory, writeLightMemory } = require("./lib/lightMemory");
const { scanDevices } = require("./lib/scan");
const QlcEngine = require("./lib/qlcEngine");
const { buildWorkspaceXml } = require("./lib/qxwGenerator");

const SERVER_HOST = process.env.PIKA_SHOW_HOST || "show.pika.club";
// 正常生产环境走 wss://<域名>/agent；PIKA_SHOW_WS_URL 主要是测试/自建部署用，
// 允许整条覆盖（比如本地联调用 ws://127.0.0.1:9301/agent）。
const WS_URL = process.env.PIKA_SHOW_WS_URL || `wss://${SERVER_HOST}/agent`;
const COMMAND_TIMEOUT_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// 灯光库同步过来的 venueFixtures（LibraryFixturePayload：name/category/unitCount/
// functions）不带"这个型号总共有几个通道"这种整体声明——这是 light-sync-ui 那边
// saveLibrary 同步的数据形状本来就没有这个字段，不是这里漏读了。这里先按型号类别
// 给一个保守的默认通道数撑起来，再跟这个型号所有白话功能已经映射到的最大通道号取
// 较大值，保证精确映射(functions[].channelValues)引用的通道确实存在于生成的
// Generic 灯具里——这样已经配置过映射的功能不会因为通道数不够而丢指令，但整体通道
// 数依然是近似值，等 light-sync-ui 那边把每个型号的真实通道数也同步过来之后，
// DEFAULT_CHANNELS_BY_CATEGORY 这个默认表就该整个删掉、改成直接读真实值。
const DEFAULT_CHANNELS_BY_CATEGORY = {
  mover: 8,
  wash: 6,
  par: 4,
  strobe: 2,
  laser: 4,
  // led_screen 不走 DMX（网络连接，见 types.ts 的 ConnectionKind），
  // 不应该出现在 QLC+ 的配接方案里，下面生成的时候会整类跳过。
};

const GENERATED_WORKSPACE_PATH = path.join(config.CONFIG_DIR, "auto-generated.qxw");

/** venueFixtures 里的一条型号 -> qxwGenerator 需要的 DMX 型号描述（含白话功能映射）。 */
function toDmxFixtures(venueFixtures) {
  return (venueFixtures || [])
    .filter((f) => f.category !== "led_screen")
    .map((f) => {
      const functions = f.functions || [];
      const maxMappedChannel = Math.max(
        0,
        ...functions.flatMap((fn) => (fn.channelValues || []).map((cv) => cv.channel))
      );
      const channels = Math.max(DEFAULT_CHANNELS_BY_CATEGORY[f.category] || 4, maxMappedChannel);
      return { name: f.name, channels, quantity: Math.max(1, f.unitCount || 1), functions };
    });
}

/** 把灯光库的型号列表转成 QLC+ 配接方案并重新加载——灯光库同步之后调用。 */
function regenerateWorkspace(content) {
  const fixtures = toDmxFixtures(content?.venueFixtures);
  if (fixtures.length === 0) {
    log("灯光库里没有需要走 DMX 的型号，跳过生成配接方案");
    return;
  }
  fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
  const { xml } = buildWorkspaceXml(fixtures);
  fs.writeFileSync(GENERATED_WORKSPACE_PATH, xml);
  log(`已生成配接方案(${fixtures.length} 种型号): ${GENERATED_WORKSPACE_PATH}`);
  qlc.reload(GENERATED_WORKSPACE_PATH);
}

/** 轮询直到 QLC+ 的 WebSocket 重新可用，或者等到超时——reload() 没有完成回调，只能这样等。 */
function waitForQlcReady(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (qlc.ready) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 300);
    })();
  });
}

/**
 * "发送到灯控台"：把方案(Show)连同当前灯光库的灯具型号一起重新生成配接方案
 * （灯具型号 + 这个方案翻译出来的 Function），重启 QLC+ 加载，加载完成后
 * 直接触发生成的 Chaser 播放。见 lib/qxwGenerator.js 顶部注释——每个 ShowEvent
 * 命中哪个型号的白话功能就用该型号灯光库里配置好的真实通道映射，没配置过映射的
 * 功能才会退回占位效果，不是全部都是占位。
 */
async function handleSendShow(id, show) {
  try {
    const existing = readLightMemory();
    const fixtures = toDmxFixtures(existing.exists ? existing.content?.venueFixtures : []);
    if (fixtures.length === 0) {
      send({ type: "send_show_result", id, ok: false, error: "本地灯光库还没有 DMX 灯具型号，先同步灯光库再发送方案" });
      return;
    }
    const { xml, chaseFunctionId } = buildWorkspaceXml(fixtures, null, show);
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(GENERATED_WORKSPACE_PATH, xml);
    log(`收到方案「${show?.displayName || show?.fileName || show?.id}」(${show?.events?.length || 0} 个节点)，重新加载 QLC+`);
    qlc.reload(GENERATED_WORKSPACE_PATH);
    const ready = await waitForQlcReady(15000);
    if (!ready) {
      send({ type: "send_show_result", id, ok: false, error: "QLC+ 重启后连接超时，方案已写入但未能确认播放" });
      return;
    }
    qlc.setFunctionStatus(chaseFunctionId, true);
    send({ type: "send_show_result", id, ok: true, functionId: chaseFunctionId });
  } catch (e) {
    send({ type: "send_show_result", id, ok: false, error: e.message });
  }
}

const qlc = new QlcEngine({
  binaryPath: process.env.QLCPLUS_BIN || "qlcplus.exe",
  port: Number(process.env.QLCPLUS_PORT || 9999),
  // 优先用上一次生成过的配接方案启动，没有的话退回环境变量指定的（如果有）。
  workspace: fs.existsSync(GENERATED_WORKSPACE_PATH)
    ? GENERATED_WORKSPACE_PATH
    : (process.env.QLCPLUS_WORKSPACE || null),
});
qlc.start();

// 启动时如果本地已经有同步过的灯光库，且还没生成过配接方案，先补一次——
// 覆盖"程序重装/配接方案文件被删掉，但灯光库数据还在"这种情况。
if (!fs.existsSync(GENERATED_WORKSPACE_PATH)) {
  const existing = readLightMemory();
  if (existing.exists) regenerateWorkspace(existing.content);
}

let ws = null;
let reconnectAttempt = 0;
let awaitingPairingInput = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function promptForPairingCode() {
  if (awaitingPairingInput) return;
  awaitingPairingInput = true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question("请输入管理员在 Telegram 里收到的配对验证码: ", (code) => {
    rl.close();
    awaitingPairingInput = false;
    send({ type: "verify_pairing_code", mac_address: config.getMacAddress(), code: code.trim() });
  });
}

function handleCommand(id, command) {
  exec(command, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    const output = (stdout || "") + (stderr || "");
    if (err && err.killed) {
      send({ type: "command_result", id, status: "timeout", output: output || "命令执行超时" });
    } else if (err) {
      send({ type: "command_result", id, status: "error", output: output || err.message });
    } else {
      send({ type: "command_result", id, status: "ok", output });
    }
  });
}

function connect() {
  const cfg = config.load();
  log(`连接到 ${WS_URL} ...`);
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    reconnectAttempt = 0;
    const mac = config.getMacAddress();
    if (cfg.device_token) {
      log("已有 device_token，尝试自动认证");
      send({ type: "auth", mac_address: mac, device_token: cfg.device_token });
    } else {
      log("尚未配对，正在请求验证码（请让管理员查看 Telegram）");
      send({
        type: "request_pairing_code",
        mac_address: mac,
        hostname: require("os").hostname(),
        os: process.platform,
      });
    }
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case "pairing_code_sent":
        log("验证码已推送给管理员");
        promptForPairingCode();
        break;
      case "pairing_failed":
        log(`配对失败: ${msg.reason}，请重新获取验证码`);
        break;
      case "pairing_success": {
        const cfg2 = config.load();
        cfg2.device_token = msg.device_token;
        config.save(cfg2);
        log("配对成功，device_token 已保存到本地");
        break;
      }
      case "pc_info":
        log(`已连接并认证成功，PIKA-Show 里看到的设备名: ${msg.name}`);
        break;
      case "ping":
        send({ type: "pong" });
        break;
      case "command":
        log(`收到命令(id=${msg.id}): ${msg.command}`);
        handleCommand(msg.id, msg.command);
        break;
      case "read_memory": {
        const result = readLightMemory();
        send({ type: "memory_content", id: msg.id, ...result });
        break;
      }
      case "write_memory": {
        const result = writeLightMemory(msg.content);
        send({ type: "memory_write_result", id: msg.id, ...result });
        if (result.ok) regenerateWorkspace(msg.content);
        break;
      }
      case "scan_devices":
        scanDevices().then((devices) => {
          send({ type: "scan_result", id: msg.id, ok: true, devices });
        }).catch((e) => {
          send({ type: "scan_result", id: msg.id, ok: false, error: e.message });
        });
        break;
      case "send_show":
        log(`收到"发送到灯控台"请求(id=${msg.id})`);
        handleSendShow(msg.id, msg.show);
        break;
      default:
        log(`未知消息类型: ${msg.type}`);
    }
  });

  ws.on("close", (code, reason) => {
    log(`连接断开(code=${code} ${reason}), 准备重连`);
    scheduleReconnect();
  });

  ws.on("error", (e) => {
    log(`连接错误: ${e.message}`);
  });
}

function scheduleReconnect() {
  reconnectAttempt += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  log(`${delay / 1000} 秒后重连（第 ${reconnectAttempt} 次）`);
  setTimeout(connect, delay);
}

function shutdown() {
  log("正在退出...");
  qlc.stop();
  if (ws) ws.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

connect();
