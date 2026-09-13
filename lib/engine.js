/**
 * 远程客户端的"引擎"——原来全部堆在 index.js 顶层的连接/QLC+/配对逻辑搬进这个
 * class，供 GUI（lib/ui.js）订阅状态变化、下发操作。跟以前唯一的行为差异：
 * 配对验证码不再走 readline 问控制台，而是 emit('state', ...) 让 UI 弹输入框，
 * GUI 调 submitPairingCode() 把填的码传回来——这是"加图形界面"这件事本身要求的
 * 改动，其余 WS 协议、QLC+ 管理、灯光库同步逻辑原样保留，没有精简。
 */

const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const { readLightMemory, writeLightMemory } = require("./lightMemory");
const { scanDevices } = require("./scan");
const QlcEngine = require("./qlcEngine");
const { buildWorkspaceXml, CONNECTION_UNIVERSE_ID } = require("./qxwGenerator");

const SERVER_HOST = process.env.PIKA_SHOW_HOST || "show.pika.club";
const WS_URL = process.env.PIKA_SHOW_WS_URL || `wss://${SERVER_HOST}/agent`;
const COMMAND_TIMEOUT_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;

// 2026-09 起 light-sync-ui 建型号时强制要求填真实通道数（模板来自 OFL 的自带
// channelCount，手动建的也要求用户填），并通过 venueFixtures[].channelCount
// 传过来——这是真实值，必须优先用它。下面这个"按标签猜"只是兜底，应付极少数
// 还没升级、云端缓存里没有 channelCount 字段的旧数据，往后应该越来越用不上；
// 猜错通道数会导致这台之后所有灯具的 DMX 起始地址一起错位，不是小事，只在
// 真的没有任何真实数据时才该走到这一步。
const DEFAULT_CHANNELS_BY_TAG = [
  ["摇头", 8],
  ["染色", 6],
  ["频闪", 2],
  ["激光", 4],
  ["帕灯", 4],
];
function guessDefaultChannels(f) {
  if (f.category === "fx_machine") return 2; // 雪花机/薄雾机之类，通常一两个通道（开关/强度）
  const tags = f.tags || [];
  for (const [keyword, count] of DEFAULT_CHANNELS_BY_TAG) {
    if (tags.some((t) => t.includes(keyword))) return count;
  }
  return 4;
}

const GENERATED_WORKSPACE_PATH = path.join(config.CONFIG_DIR, "auto-generated.qxw");

function toDmxFixtures(venueFixtures) {
  return (venueFixtures || [])
    .filter((f) => f.category !== "led_screen")
    .map((f) => {
      const functions = f.functions || [];
      const maxMappedChannel = Math.max(
        0,
        ...functions.flatMap((fn) => (fn.channelValues || []).map((cv) => cv.channel))
      );
      const channels = Math.max(f.channelCount || guessDefaultChannels(f), maxMappedChannel);
      // connection 决定分到哪路 Universe（见 qxwGenerator.js 的 CONNECTION_UNIVERSE_ID）——
      // 云端快照 2026-09-13 起才开始传这个字段，老数据/异常情况缺失时按 "midi" 兜底
      // （虽然不一定对，但至少跟之前"全部当 midi 塞进一路"的旧行为不会更差）。
      const connection = f.connection === "dmx" ? "dmx" : "midi";
      return { name: f.name, channels, quantity: Math.max(1, f.unitCount || 1), functions, connection };
    });
}

class RemoteEngine extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.reconnectAttempt = 0;
    this._reconnectTimer = null;
    this._userDisconnected = false; // GUI 点了"断开"——跟连接错误的自动重连区分开
    this.macAddress = config.getMacAddress();
    this.deviceName = this.macAddress;
    this.ownerTelegramId = null;
    this.connected = false;
    this.pairingPending = false; // 服务端已经发了验证码，正在等 GUI 提交

    this.qlc = new QlcEngine({
      binaryPath: process.env.QLCPLUS_BIN || "qlcplus.exe",
      port: Number(process.env.QLCPLUS_PORT || 9999),
      workspace: fs.existsSync(GENERATED_WORKSPACE_PATH)
        ? GENERATED_WORKSPACE_PATH
        : (process.env.QLCPLUS_WORKSPACE || null),
    });
    // QLC+ 每次连上（刚启动/reload 之后）就去读一次人工在网页配置界面选好的
    // 真实输出接口，按连接方式抄进本地配置——见 config.js 顶部 outputPatches
    // 的注释，这是"每次重新生成配接方案，输出口配置会被 QLC+ 自己重置掉"这个
    // 坑的修法。每路 Universe 独立判断有没有变化，互不影响。
    this.qlc.on("ready", () => {
      this.qlc.readOutputPatch().then((patchesByUniverseId) => {
        if (!patchesByUniverseId || Object.keys(patchesByUniverseId).length === 0) return;
        const cfg = config.load();
        cfg.outputPatches = cfg.outputPatches || {};
        let changed = false;
        for (const [connKey, universeId] of Object.entries(CONNECTION_UNIVERSE_ID)) {
          const patch = patchesByUniverseId[universeId];
          if (!patch) continue;
          const existing = cfg.outputPatches[connKey];
          const same = existing && existing.plugin === patch.plugin && existing.line === patch.line;
          if (same) continue;
          cfg.outputPatches[connKey] = patch;
          changed = true;
          this.log(`记录到 ${connKey.toUpperCase()} 路真实输出接口: [${patch.plugin}] ${patch.lineName}，以后生成配接方案会自动带上`);
        }
        if (changed) config.save(cfg);
      });
    });
  }

  log(msg) {
    const line = `[${new Date().toISOString()}] ${msg}`;
    console.log(line);
    this.emit("log", line);
  }

  getState() {
    return {
      connected: this.connected,
      pairingPending: this.pairingPending,
      deviceName: this.deviceName,
      ownerTelegramId: this.ownerTelegramId,
      macAddress: this.macAddress,
      qlcReady: this.qlc.ready,
    };
  }

  _emitState() {
    this.emit("state", this.getState());
  }

  start() {
    this.qlc.start();
    if (!fs.existsSync(GENERATED_WORKSPACE_PATH)) {
      const existing = readLightMemory();
      if (existing.exists) this._regenerateWorkspace(existing.content);
    }
    this._userDisconnected = false;
    this._connect();
  }

  /** GUI"断开"开关——停止重连、关掉当前连接，不影响本地已经在跑的 QLC+。 */
  disconnect() {
    this._userDisconnected = true;
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; }
    if (this.ws) { this.ws.removeAllListeners(); this.ws.close(); this.ws = null; }
    this.connected = false;
    this._emitState();
    this.log("已手动断开");
  }

  /** GUI"连接"开关——重新走一遍连接流程。 */
  reconnect() {
    this._userDisconnected = false;
    this.reconnectAttempt = 0;
    this._connect();
  }

  _send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  /** GUI 提交配对验证码——原来是 readline 问控制台，现在页面填完点提交调这个。 */
  submitPairingCode(code) {
    if (!this.pairingPending) return;
    this._send({ type: "verify_pairing_code", mac_address: this.macAddress, code: String(code || "").trim() });
  }

  /** GUI 改名提交——见 agent-server.js 的 set_name 处理，成功后服务端会重推 pc_info。 */
  setName(name) {
    this._send({ type: "set_name", name: String(name || "").trim() });
  }

  _connect() {
    const cfg = config.load();
    this.log(`连接到 ${WS_URL} ...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      if (cfg.device_token) {
        this.log("已有 device_token，尝试自动认证");
        this._send({ type: "auth", mac_address: this.macAddress, device_token: cfg.device_token });
      } else {
        this.log("尚未配对，正在请求验证码（请让管理员查看 Telegram）");
        this._send({
          type: "request_pairing_code",
          mac_address: this.macAddress,
          hostname: require("os").hostname(),
          os: process.platform,
        });
      }
    });

    this.ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case "pairing_code_sent":
          this.log("验证码已推送给管理员");
          this.pairingPending = true;
          this._emitState();
          break;
        case "pairing_failed":
          this.log(`配对失败: ${msg.reason}，请重新获取验证码`);
          this.emit("pairing_failed", msg.reason);
          break;
        case "pairing_success": {
          const cfg2 = config.load();
          cfg2.device_token = msg.device_token;
          config.save(cfg2);
          this.pairingPending = false;
          this.log("配对成功，device_token 已保存到本地");
          this._emitState();
          break;
        }
        case "pc_info":
          this.deviceName = msg.name || this.macAddress;
          this.ownerTelegramId = msg.ownerTelegramId || null;
          this.connected = true;
          this.log(`已连接并认证成功，PIKA-Show 里看到的设备名: ${msg.name}`);
          this._emitState();
          break;
        case "set_name_result":
          this.emit("set_name_result", msg);
          break;
        case "ping":
          this._send({ type: "pong" });
          break;
        case "command":
          this.log(`收到命令(id=${msg.id}): ${msg.command}`);
          this._handleCommand(msg.id, msg.command);
          break;
        case "read_memory": {
          const result = readLightMemory();
          this._send({ type: "memory_content", id: msg.id, ...result });
          break;
        }
        case "write_memory": {
          const result = writeLightMemory(msg.content);
          this._send({ type: "memory_write_result", id: msg.id, ...result });
          if (result.ok) this._regenerateWorkspace(msg.content);
          break;
        }
        case "scan_devices":
          scanDevices().then((devices) => {
            this._send({ type: "scan_result", id: msg.id, ok: true, devices });
          }).catch((e) => {
            this._send({ type: "scan_result", id: msg.id, ok: false, error: e.message });
          });
          break;
        case "send_show":
          this.log(`收到"发送到灯控台"请求(id=${msg.id})`);
          this._handleSendShow(msg.id, msg.show);
          break;
        default:
          this.log(`未知消息类型: ${msg.type}`);
      }
    });

    this.ws.on("close", (code, reason) => {
      this.connected = false;
      this._emitState();
      if (this._userDisconnected) return; // 手动断开，不自动重连
      this.log(`连接断开(code=${code} ${reason}), 准备重连`);
      this._scheduleReconnect();
    });

    this.ws.on("error", (e) => {
      this.log(`连接错误: ${e.message}`);
    });
  }

  _scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.log(`${delay / 1000} 秒后重连（第 ${this.reconnectAttempt} 次）`);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  _handleCommand(id, command) {
    exec(command, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = (stdout || "") + (stderr || "");
      if (err && err.killed) {
        this._send({ type: "command_result", id, status: "timeout", output: output || "命令执行超时" });
      } else if (err) {
        this._send({ type: "command_result", id, status: "error", output: output || err.message });
      } else {
        this._send({ type: "command_result", id, status: "ok", output });
      }
    });
  }

  _regenerateWorkspace(content) {
    const fixtures = toDmxFixtures(content?.venueFixtures);
    if (fixtures.length === 0) {
      this.log("灯光库里没有需要走 DMX 的型号，跳过生成配接方案");
      return;
    }
    fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
    const { xml } = buildWorkspaceXml(fixtures, config.load().outputPatches || {});
    fs.writeFileSync(GENERATED_WORKSPACE_PATH, xml);
    this.log(`已生成配接方案(${fixtures.length} 种型号): ${GENERATED_WORKSPACE_PATH}`);
    this.qlc.reload(GENERATED_WORKSPACE_PATH);
  }

  _waitForQlcReady(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.qlc.ready) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 300);
      };
      check();
    });
  }

  async _handleSendShow(id, show) {
    try {
      const existing = readLightMemory();
      const fixtures = toDmxFixtures(existing.exists ? existing.content?.venueFixtures : []);
      if (fixtures.length === 0) {
        this._send({ type: "send_show_result", id, ok: false, error: "本地灯光库还没有 DMX 灯具型号，先同步灯光库再发送方案" });
        return;
      }
      const { xml, chaseFunctionId } = buildWorkspaceXml(fixtures, config.load().outputPatches || {}, show);
      fs.mkdirSync(config.CONFIG_DIR, { recursive: true });
      fs.writeFileSync(GENERATED_WORKSPACE_PATH, xml);
      this.log(`收到方案「${show?.displayName || show?.fileName || show?.id}」(${show?.events?.length || 0} 个节点)，重新加载 QLC+`);
      this.qlc.reload(GENERATED_WORKSPACE_PATH);
      const ready = await this._waitForQlcReady(15000);
      if (!ready) {
        this._send({ type: "send_show_result", id, ok: false, error: "QLC+ 重启后连接超时，方案已写入但未能确认播放" });
        return;
      }
      this.qlc.setFunctionStatus(chaseFunctionId, true);
      this._send({ type: "send_show_result", id, ok: true, functionId: chaseFunctionId });
    } catch (e) {
      this._send({ type: "send_show_result", id, ok: false, error: e.message });
    }
  }

  shutdown() {
    this._userDisconnected = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this.qlc.stop();
    if (this.ws) this.ws.close();
  }
}

module.exports = RemoteEngine;
