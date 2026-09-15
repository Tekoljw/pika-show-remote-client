/**
 * 远程客户端的"引擎"——原来全部堆在 index.js 顶层的连接/QLC+/配对逻辑搬进这个
 * class，供 GUI（lib/ui.js）订阅状态变化、下发操作。
 *
 * ⚠️ 2026-09-15 起改成密钥直连（取代验证码人工配对流程，管理员逐条确认，
 * 见项目记忆 reference_pc_key_auth.md，改这个文件前先看那份）：
 *   1. 不再有验证码——本地存的密钥（config.js 的 getKey/setKey，DPAPI 加密）
 *      每次连接（含首次启动和任何原因的重连）自动带上发 authenticate，
 *      没有密钥才 emit('state', {needsKey:true}) 让 GUI 弹输入框，用户粘贴
 *      一次密钥（submitKey()）之后自动存本地，以后不用再输。
 *   2. 支持断线自动重连，不再要求每次重连都重新走人工流程——跟旧版"没有
 *      记住我"是相反方向，这次是管理员明确要的："客户端不再需要验证码，
 *      启动直接连接...断线自动重连，除非用户手动退出或点击离线"。
 *   3. 密钥被服务端判定失效（吊销/格式不对，见 auth_error 处理）会清掉本地
 *      这份、重新弹输入框，不会带着一把死密钥无限重试。
 *   4. "已连接"不是收到一次 pc_info 就永久为真——客户端侧心跳超时检测：
 *      收到服务端任意消息就刷新时间戳，超过阈值没收到任何消息（说明握手
 *      可能成功但通信已经死了）就主动断开触发重连，见 _lastServerMessageAt。
 *   5. 收到的 command 消息带 fromUserId/isOwner——执行前自己再校验一遍
 *      "这条指令是不是我认的这个人发的"，跟服务端的 canAccessPC 校验是
 *      两道独立的闸，见 _handleCommand。
 */

const WebSocket = require("ws");
const { EventEmitter } = require("events");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const { readLightMemory, writeLightMemory } = require("./lightMemory");
const showStorage = require("./showStorage");
const { scanDevices } = require("./scan");
const QlcEngine = require("./qlcEngine");
const { buildWorkspaceXml, CONNECTION_UNIVERSE_ID } = require("./qxwGenerator");

const SERVER_HOST = process.env.PIKA_SHOW_HOST || "show.pika.club";
const WS_URL = process.env.PIKA_SHOW_WS_URL || `wss://${SERVER_HOST}/agent`;

/**
 * QLC+ 可执行文件在哪——2026-09-14 起不再强制要求用户自己单独装 QLC+，
 * 打包时把官方 QLC+ 安装包解出来的整个目录跟我们自己的 exe 放一起分发，
 * 见项目记忆 reference_qlcplus_bundling.md。优先级：
 *   1. QLCPLUS_BIN 环境变量——显式指定，最高优先级，不变。
 *   2. 跟这次运行的程序放在一起的那份（"qlcplus/qlcplus.exe"）——
 *      打包成 exe 时是 exe 同级目录；源码直跑(dev)时是这个仓库根目录下的
 *      同名目录，方便本地测试打包流程。
 *   3. 都没有就退回系统 PATH 里找"qlcplus.exe"——兼容用户电脑上本来就
 *      单独装过 QLC+ 的情况，不强制覆盖，也是旧版本客户端的行为，不破坏它。
 */
function resolveQlcBinaryPath() {
  if (process.env.QLCPLUS_BIN) return process.env.QLCPLUS_BIN;
  const baseDir = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, "..");
  const bundled = path.join(baseDir, "qlcplus", "qlcplus.exe");
  if (fs.existsSync(bundled)) return bundled;
  return "qlcplus.exe";
}
const COMMAND_TIMEOUT_MS = 30000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 60000;
// 服务端每 15s ping 一次、2 个周期（30s）收不到 pong 就判定死连接（见
// agent-server.js 的 HEARTBEAT_TIMEOUT_MS）。客户端这边留比服务端宽一点的
// 余量再判定，避免两边同时因为一次网络抖动各自抢着重连。
const CLIENT_HEARTBEAT_TIMEOUT_MS = 40000;
const CLIENT_HEARTBEAT_CHECK_INTERVAL_MS = 5000;

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
    this.needsKey = false; // 本地没有可用密钥，等 GUI 调 submitKey() 提交
    this._lastServerMessageAt = null; // 客户端侧心跳超时检测用，见 _startHeartbeatWatch
    this._heartbeatWatchTimer = null;

    this.qlc = new QlcEngine({
      binaryPath: resolveQlcBinaryPath(),
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
      needsKey: this.needsKey,
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
    this._stopHeartbeatWatch();
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

  /** GUI 提交密钥——粘贴一次密钥点提交调这个，成功后存本地（DPAPI 加密），
   *  以后不用再输，见 config.js 头部注释。当前这条连接是打开的就直接认证；
   *  如果连接还没建立（极少见，比如刚启动那一瞬间），先记下来，等 open
   *  事件里自动带上。 */
  submitKey(key) {
    const trimmed = String(key || "").trim();
    if (!trimmed) return;
    this._pendingKeySubmit = trimmed;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this._authenticate(trimmed);
  }

  _authenticate(key) {
    this._send({
      type: "authenticate",
      key,
      mac_address: this.macAddress,
      hostname: require("os").hostname(),
      os: process.platform,
    });
  }

  /** GUI 改名提交——见 agent-server.js 的 set_name 处理，成功后服务端会重推 pc_info。 */
  setName(name) {
    this._send({ type: "set_name", name: String(name || "").trim() });
  }

  _connect() {
    this.log(`连接到 ${WS_URL} ...`);
    this.ws = new WebSocket(WS_URL);

    this.ws.on("open", () => {
      this.reconnectAttempt = 0;
      this._startHeartbeatWatch();
      // 密钥优先级：GUI 刚提交的（_pendingKeySubmit，覆盖本地旧值场景，比如
      // 换了一把新密钥）> 本地已存的 > 都没有就等 GUI 输入，见文件头注释第 1 条。
      const key = this._pendingKeySubmit || config.getKey();
      if (key) {
        this.needsKey = false;
        this.log("正在用本地密钥连接...");
        this._authenticate(key);
      } else {
        this.needsKey = true;
        this.log("本地没有密钥，等待在客户端里输入");
        this._emitState();
      }
    });

    this.ws.on("message", (raw) => {
      this._lastServerMessageAt = Date.now();
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case "authenticated": {
          this.needsKey = false;
          // 认证成功说明这把密钥是有效的——不管是刚提交的新密钥还是本地
          // 原来存的旧密钥，都（重新）写一遍本地存储，保证 GUI 刚提交的
          // 那把从这一刻起变成"本地已存"的那份，下次重连不用再问。
          if (this._pendingKeySubmit) config.setKey(this._pendingKeySubmit);
          this._pendingKeySubmit = null;
          this.log("密钥认证成功");
          this._emitState();
          break;
        }
        case "auth_error": {
          this.log(`认证失败: ${msg.reason}`);
          // invalid_key：密钥本身就是错的/已被吊销，留着没有意义，清掉本地
          // 存的这份（如果这把恰好就是本地存的那把），逼 GUI 重新弹输入框——
          // 不清掉的话每次重连都会拿同一把死密钥去试，永远连不上也永远不
          // 会提示用户该怎么办。missing_key 不清（本来就没存东西可清）。
          if (msg.reason === "invalid_key") config.clearKey();
          this._pendingKeySubmit = null;
          this.needsKey = true;
          this.emit("auth_error", msg.reason);
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
          this._handleCommand(msg.id, msg.command, msg.fromUserId, msg.isOwner);
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
        case "probe_channel":
          this._handleProbeChannel(msg.id, msg.connection, msg.channel, msg.value);
          break;
        case "list_shows": {
          const result = showStorage.listShows();
          this._send({ type: "shows_list", id: msg.id, ...result });
          break;
        }
        case "write_show": {
          const result = showStorage.writeShow(msg.show);
          this._send({ type: "write_show_result", id: msg.id, ...result });
          break;
        }
        case "delete_show": {
          const result = showStorage.deleteShow(msg.showId);
          this._send({ type: "delete_show_result", id: msg.id, ...result });
          break;
        }
        case "write_show_groups": {
          const result = showStorage.writeShowGroups(msg.groups);
          this._send({ type: "write_show_groups_result", id: msg.id, ...result });
          break;
        }
        case "list_console_shows": {
          const result = showStorage.listConsoleShows();
          this._send({ type: "console_shows_list", id: msg.id, ...result });
          break;
        }
        default:
          this.log(`未知消息类型: ${msg.type}`);
      }
    });

    this.ws.on("close", (code, reason) => {
      this._stopHeartbeatWatch();
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

  /** 客户端侧心跳超时检测——见文件头注释第 2 条。服务端会定期发 ping，
   *  正常情况下每隔几秒就会收到点什么；真超过阈值没收到任何消息，说明
   *  握手可能成功但通信已经死了（比如中间网络设备悄悄把连接吃掉），
   *  这种情况原来的代码完全没有能力发现——"connected" 一旦置 true 就
   *  永远不会自己变回 false，直到用户手动发现功能不工作。 */
  _startHeartbeatWatch() {
    this._lastServerMessageAt = Date.now();
    this._stopHeartbeatWatch();
    this._heartbeatWatchTimer = setInterval(() => {
      if (Date.now() - this._lastServerMessageAt > CLIENT_HEARTBEAT_TIMEOUT_MS) {
        this.log(`心跳超时（超过 ${CLIENT_HEARTBEAT_TIMEOUT_MS / 1000}s 没收到服务端任何消息），判定断线，主动重连`);
        if (this.ws) this.ws.terminate ? this.ws.terminate() : this.ws.close();
      }
    }, CLIENT_HEARTBEAT_CHECK_INTERVAL_MS);
    if (this._heartbeatWatchTimer.unref) this._heartbeatWatchTimer.unref();
  }

  _stopHeartbeatWatch() {
    if (this._heartbeatWatchTimer) { clearInterval(this._heartbeatWatchTimer); this._heartbeatWatchTimer = null; }
  }

  _scheduleReconnect() {
    this.reconnectAttempt += 1;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
    this.log(`${delay / 1000} 秒后重连（第 ${this.reconnectAttempt} 次）`);
    this._reconnectTimer = setTimeout(() => this._connect(), delay);
  }

  /**
   * 硬卡：这条指令是不是我认的这个人发的——服务端的 canAccessPC 已经校验过
   * 一次，这里是客户端自己独立再校验一遍（防御性的第二道闸，不是信不过
   * 服务端，是万一服务端那层校验逻辑有 bug，这道闸能拦住，不是"信道加密"
   * 那种防篡改，而是"两处都要判断对才放行"），管理员原话"客户端增加用户
   * 校验，硬卡"。
   *   - isOwner=true：owner 的指令，无条件放行。
   *   - fromUserId == null：服务端没有把这条指令归到任何具体人（EC2 控制台
   *     直连内部 API 这类可信调用），视为可信，放行——不是漏洞，是这条
   *     通道本来就该给基础设施级别的调用用，见 agent-server.js 的
   *     "EC2 直接调用不传 userId 视为可信内部调用"。
   *   - 其余情况：fromUserId 必须等于这条连接密钥归属的 ownerTelegramId，
   *     不是就整条拒绝、不执行，回一个明确的错误原因。
   */
  _handleCommand(id, command, fromUserId, isOwner) {
    if (!isOwner && fromUserId != null && String(fromUserId) !== String(this.ownerTelegramId)) {
      this.log(`拒绝执行(id=${id}): 指令来自 ${fromUserId}，不是这台 PC 的密钥归属者(${this.ownerTelegramId})`);
      this._send({ type: "command_result", id, status: "rejected", output: "这条指令的发起人不是这台 PC 的归属用户，客户端拒绝执行" });
      return;
    }
    // windowsHide：跟 qlcEngine.js 的 spawn 同一个坑——主进程 v1.2.2 起没有
    // 控制台了，这里默认的 shell 子进程 (cmd.exe) 不加这个选项会单独弹一个
    // 控制台窗口，执行完自动关闭，表现为"执行任务时黑框一闪而过"。只影响
    // 窗口显示，stdout/stderr 照样通过管道正常收集，不影响命令输出结果。
    exec(command, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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

  /**
   * 逐通道实测——给一个还没正式建型号的端口，直接推一个原始测试值到某个假定
   * 相对通道号，让用户看真灯反应，一个通道一个通道摸出真实功能，见项目记忆
   * `reference_ofl_device_matching.md`"下一步方向"那节。不走"配接方案"（那需要
   * 先把设备正式 patch 进去，且改配接方案要重启 QLC+），而是复用已经在跑的
   * QLC+ 连接直接发 CH 命令——2026-09-13 实测确认这样不需要重启、不影响正在跑
   * 的其它灯光。前提是这个连接方式已经在 QLC+ 网页配置界面配好真实硬件输出，
   * 没配过的话发了也没有物理效果，这里提前检查报错，不让用户以为测试生效了。
   */
  _handleProbeChannel(id, connection, channel, value) {
    const connKey = connection === "dmx" ? "dmx" : "midi";
    const cfg = config.load();
    if (!cfg.outputPatches || !cfg.outputPatches[connKey]) {
      this._send({ type: "probe_result", id, ok: false, error: `${connKey.toUpperCase()} 路还没有配置真实硬件输出接口，请先在 QLC+ 网页配置界面（/config）里选好，再回来测试` });
      return;
    }
    if (!this.qlc.ready) {
      this._send({ type: "probe_result", id, ok: false, error: "QLC+ 还没连上，稍后再试" });
      return;
    }
    const relativeChannel = Math.max(1, Math.min(512, Math.round(Number(channel)) || 1));
    const clampedValue = Math.max(0, Math.min(255, Math.round(Number(value)) || 0));
    const absoluteAddress = CONNECTION_UNIVERSE_ID[connKey] * 512 + relativeChannel;
    this.qlc.setChannel(absoluteAddress, clampedValue);
    this._send({ type: "probe_result", id, ok: true });
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
      // "灯控台"存档——真正确认播放成功之后才留痕，跟 GENERATED_WORKSPACE_PATH
      // 那份"当前工作区"不是一回事：那份下一个作品发送就会被覆盖，这份按
      // show.id 独立保存，见 showStorage.js 顶部注释。存档失败不影响发送本身
      // 已经成功这个结果，只记日志。
      const archived = showStorage.archiveConsoleShow(show, xml, chaseFunctionId);
      if (!archived.ok) this.log(`灯控台存档失败（不影响本次发送）: ${archived.error}`);
      this._send({ type: "send_show_result", id, ok: true, functionId: chaseFunctionId });
    } catch (e) {
      this._send({ type: "send_show_result", id, ok: false, error: e.message });
    }
  }

  shutdown() {
    this._userDisconnected = true;
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    this._stopHeartbeatWatch();
    this.qlc.stop();
    if (this.ws) this.ws.close();
  }
}

module.exports = RemoteEngine;
