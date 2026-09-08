/**
 * 扫描这台 PC 实际接了哪些 MIDI/串口设备——只给用户/AI 看"接了什么"，
 * 不自动生成灯具型号定义（型号跟物理端口的对应关系继续靠人工在
 * light-sync-ui「直播间设备」页面里维护/核实）。
 *
 * 跟原来 Python 版 agent.py 的 light_list_devices() 返回形状保持一致：
 *   { midi: string[], serial: { device, description }[] }
 * 这个形状是 server/index.js -> src/miniappBridge.ts 的 ScanDevicesResult
 * 已经在用的，不能改。
 */

function scanMidi() {
  try {
    // eslint-disable-next-line global-require
    const easymidi = require("easymidi");
    return easymidi.getOutputs();
  } catch (e) {
    console.error(`[SCAN] MIDI 枚举失败: ${e.message}`);
    return [];
  }
}

async function scanSerial() {
  try {
    // eslint-disable-next-line global-require
    const { SerialPort } = require("serialport");
    const list = await SerialPort.list();
    return list.map((p) => ({ device: p.path, description: p.manufacturer || p.friendlyName || "" }));
  } catch (e) {
    console.error(`[SCAN] 串口枚举失败: ${e.message}`);
    return [];
  }
}

async function scanDevices() {
  const [midi, serial] = await Promise.all([scanMidi(), scanSerial()]);
  return { midi, serial };
}

module.exports = { scanDevices };
