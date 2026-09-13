/**
 * 生成 QLC+ 能直接 --open 加载的配接方案（.qxw）——只负责"把灯具型号变成
 * QLC+ 认识的 Fixture 配接"这一件事，不管发送/触发（那是 qlcEngine.js 的事）。
 *
 * 关键设计：全部用 QLC+ 官方支持的内置 "Generic/Generic/Generic" 通用调光器
 * 模式（源码 engine/src/fixture.cpp：Model == KXMLFixtureGeneric 时跳过真实
 * 灯具库匹配，直接按 <Channels> 数量建一个"每个通道就是 0-255 调光值"的
 * 通用灯具），不需要把每个型号精确匹配到 QLC+/Open Fixture Library 里的
 * 某个具体品牌型号——这个匹配工作量大、容易匹配错，而且我们自己的白话层
 * 已经知道每个通道该怎么用，QLC+ 这边只需要能"设置某个通道的值"就够了。
 *
 * XML 字段名（Engine/Fixture、InputOutputMap/Universe/Output 各个标签和属性）
 * 是直接从 QLC+ 引擎源码里的常量定义抠出来的（engine/src/fixture.cpp、
 * engine/src/universe.h、engine/src/inputoutputmap.h），不是猜的格式。
 */

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({
    "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;",
  }[c]));
}

// 下面 Function(Scene/Chaser) 相关的标签名、属性名、枚举字符串常量，全部是从
// QLC+ 引擎源码里直接抠出来的（不是猜的/照抄网上示例），出处：
//   engine/src/function.h    —— KXMLQLCFunction/Name/ID/Type/Direction/RunOrder/
//                                Speed/FadeIn/Hold/FadeOut/Duration
//   engine/src/function.cpp  —— KSceneString="Scene"、KChaserString="Chaser"
//                                （注意不是"Chase"）、KForwardString="Forward"、
//                                KSingleShotString="SingleShot"
//   engine/src/scene.h       —— KXMLQLCFixtureValues="FixtureVal"
//   engine/src/qlcfixturedef.h —— KXMLQLCFixtureID="ID"（FixtureVal 的属性名）
//   engine/src/chaser.h/.cpp —— KXMLQLCChaserSpeedModes="SpeedModes"，
//                                Common/PerStep/Default 三种模式字符串
//   engine/src/chaserstep.cpp —— Step 的 Number/FadeIn/Hold/FadeOut 属性名，
//                                非 Sequence 模式下文本内容就是被引用的 Function ID

/**
 * 把一个白话功能名（"变红色"/"爆闪"...）确定性地映射成一个 0-255 的占位值。
 * 只在"这个功能没有配置精确通道映射"时才会用到——见 buildShowFunctionsXml。
 * 不是真实的 DMX 语义翻译，只是给一个可复现、能在 QLC+ 里看到"确实变了"的
 * 占位效果，让还没配置映射的功能也能跑通链路，不是长期方案。
 */
function placeholderValueForLabel(label) {
  let h = 0;
  const s = String(label || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 256;
}

/**
 * 把一个方案(Show)的时间轴节点翻译成 QLC+ 的 Function XML——每个 ShowEvent
 * 生成一个 Scene，再用一个 Chaser 按时间顺序串起来。
 *
 * 精确度分两层，各自独立：
 *   1. 这个事件到底影响哪些型号——ShowEvent.deviceIds 本身没法在这一层解析
 *      （venueFixtures 同步到 PC 之后没有保留 FixtureInstance 级别的 ID），
 *      但前端发送前(miniappBridge.ts 的 resolveShowForSend)会把 deviceIds
 *      反解成型号名字，随事件一起以 targetTypeNames 传过来——跟 ShowTimeline.tsx
 *      的编辑 UI 本来就"只能整个型号一起选"是对得上的，不是打折扣的近似。
 *      有 targetTypeNames 就只影响这些型号；没有(老数据/异常情况)才退回影响全部型号。
 *   2. 影响到的型号里，这个白话功能有没有配置过 channelValues（灯光库详情页
 *      点一个白话功能 chip 打开的通道映射编辑器，types.ts 的
 *      FixtureFunction.channelValues）：配置过就按真实通道号(1-based，跟原厂
 *      手册一致)+真实数值设置；没配置过就退回 placeholderValueForLabel 的占位效果。
 *
 * @param {{ id: string, displayName?: string, fileName?: string, events: Array<{id:string,time:number,functionLabel:string,targetTypeNames?:string[]}> }} show
 * @param {{ name: string, ids: number[], functions: Array<{ label: string, channelValues?: Array<{channel:number,value:number}> }> }[]} fixtureGroups
 *   按型号分组、已经写进 <Engine> 的 Fixture ID 列表，和 buildWorkspaceXml 里生成的一一对应。
 * @param {number} startId Function ID 从哪个数字开始分配——跟 Fixture ID 分开一段区间，避免 ID 撞车
 * @returns {{ xml: string, chaseFunctionId: number|null }}
 */
function buildShowFunctionsXml(show, fixtureGroups, startId = 10000) {
  const events = Array.isArray(show?.events) ? show.events : [];
  const allIds = fixtureGroups.flatMap((g) => g.ids);
  if (events.length === 0 || allIds.length === 0) return { xml: "", chaseFunctionId: null };

  const sorted = [...events].sort((a, b) => a.time - b.time);
  let fid = startId;
  const sceneXml = [];
  const sceneRefs = []; // { id, time }

  for (const evt of sorted) {
    const placeholderValue = placeholderValueForLabel(evt.functionLabel || evt.description);
    const hasTargets = Array.isArray(evt.targetTypeNames) && evt.targetTypeNames.length > 0;
    const fixtureValsXml = fixtureGroups
      .filter((group) => !hasTargets || evt.targetTypeNames.includes(group.name))
      .map((group) => {
        const fn = group.functions.find((f) => f.label === evt.functionLabel && f.channelValues?.length);
        if (fn) {
          // 精确映射：channel 是原厂手册的 1-based 编号，QLC+ FixtureVal 的本地通道
          // 索引是 0-based，这里做一次转换。
          const pairs = fn.channelValues.map((cv) => `${cv.channel - 1},${cv.value}`).join(",");
          return group.ids.map((fxId) => `   <FixtureVal ID="${fxId}">${pairs}</FixtureVal>`).join("\n");
        }
        // 没配置映射：退回占位值，设这个型号的第 0 通道。
        return group.ids.map((fxId) => `   <FixtureVal ID="${fxId}">0,${placeholderValue}</FixtureVal>`).join("\n");
      })
      .join("\n");
    sceneXml.push(
      `  <Function ID="${fid}" Type="Scene" Name="${escapeXml(evt.functionLabel || evt.id)}">\n` +
      `   <Speed FadeIn="0" FadeOut="0" Duration="0"/>\n` +
      fixtureValsXml + "\n" +
      `  </Function>`
    );
    sceneRefs.push({ id: fid, time: evt.time });
    fid += 1;
  }

  const chaseFunctionId = fid;
  const stepXml = sceneRefs
    .map((ref, i) => {
      const next = sceneRefs[i + 1];
      const holdSeconds = next ? Math.max(0.2, next.time - ref.time) : 2;
      const holdMs = Math.round(holdSeconds * 1000);
      return `   <Step Number="${i}" FadeIn="0" Hold="${holdMs}" FadeOut="0">${ref.id}</Step>`;
    })
    .join("\n");
  const chaseName = escapeXml(show?.displayName || show?.fileName || show?.id || "Show");
  const chaseXml =
    `  <Function ID="${chaseFunctionId}" Type="Chaser" Name="${chaseName}">\n` +
    `   <Speed FadeIn="0" FadeOut="0" Duration="0"/>\n` +
    `   <Direction>Forward</Direction>\n` +
    `   <RunOrder>SingleShot</RunOrder>\n` +
    `   <SpeedModes FadeIn="PerStep" FadeOut="PerStep" Duration="PerStep"/>\n` +
    stepXml + "\n" +
    `  </Function>`;

  return { xml: sceneXml.join("\n") + "\n" + chaseXml, chaseFunctionId };
}

// 一路 Universe 只能绑定一个真实硬件输出口——MIDI 转接口和 DMX-USB 转接器是
// 两个不同的物理设备，混进同一路 Universe 里，其中一种连接方式的灯具必然收不到
// 真实信号（2026-09-13 实测确认：之前所有连接方式的灯具全塞进 Universe 0，
// 一个直播间同时有 MIDI 灯和 DMX 灯时，只有跟 Universe 0 输出口匹配的那一种
// 能真的被控制）。改成按连接方式分 Universe，映射关系固定写死（不是按"这次
// 生成时先遇到哪种"动态分配），这样人工配置一次每路 Universe 的输出口之后，
// 这份持久化的配置（remote-client/lib/config.js 的 outputPatches，按连接方式
// 分 key）不会因为哪次灯具库里恰好缺了某种连接方式的灯具而错位。
const CONNECTION_UNIVERSE_ID = { dmx: 0, midi: 1 };

/**
 * @param {{ name: string, channels: number, quantity: number, connection: "midi"|"dmx", functions?: Array<{label:string,channelValues?:Array<{channel:number,value:number}>}> }[]} fixtureTypes
 *   每个型号需要知道:通道数(每台占用几个 DMX 地址，调用方应该已经把这个型号任何
 *   functions.channelValues 用到的最大通道号也算进去了，不然精确映射会指向一个
 *   Generic 灯具压根没有的通道)、台数、连接方式(决定分到哪路 Universe)、
 *   可选的白话功能→通道映射(来自灯光库详情页)。
 * @param {{ dmx?: {plugin:string,lineName:string,lineUID?:string,line:number}, midi?: {plugin:string,lineName:string,lineUID?:string,line:number} }} [outputPatches]
 *   每路 Universe 要绑定到哪个真实输出口，按连接方式分 key——这个信息只有连了
 *   真实硬件、人工在 QLC+ 网页配置界面选过之后才知道具体是哪一路，缺哪个 key
 *   就先不给那路 Universe 写 <Output> 标签，之后由人工配一次，见
 *   qlcEngine.js 的 readOutputPatch()——配过之后会被记住，不用每次都配。
 * @param {object|null} [show] 可选——同时把一个方案的时间轴翻译成 Function 写进同一份工作区。
 * @returns {{ xml: string, chaseFunctionId: number|null }}
 */
function buildWorkspaceXml(fixtureTypes, outputPatches = {}, show = null) {
  let id = 0;
  const fixtureXml = [];
  const fixtureGroups = []; // 按型号分组的 Fixture ID，供 buildShowFunctionsXml 按型号匹配白话功能
  const universeXml = [];

  for (const [connKey, universeId] of Object.entries(CONNECTION_UNIVERSE_ID)) {
    const typesForThisConnection = fixtureTypes.filter((t) => (t.connection || "midi") === connKey);
    let address = 0;
    for (const type of typesForThisConnection) {
      const channels = Math.max(1, Math.min(512, type.channels || 1));
      const ids = [];
      for (let i = 0; i < type.quantity; i++) {
        if (address + channels > 512) {
          // 超出一个 universe(512 通道)的部分先跳过，不静默截断数据也不崩溃——
          // 同一种连接方式的灯具超过 512 通道需要再拆一路 Universe，目前用不到，
          // 真遇到再加。
          break;
        }
        fixtureXml.push(
          `  <Fixture>\n` +
          `   <Manufacturer>Generic</Manufacturer>\n` +
          `   <Model>Generic</Model>\n` +
          `   <Mode>Generic</Mode>\n` +
          `   <ID>${id}</ID>\n` +
          `   <Name>${escapeXml(type.name)} #${i + 1}</Name>\n` +
          `   <Universe>${universeId}</Universe>\n` +
          `   <Address>${address}</Address>\n` +
          `   <Channels>${channels}</Channels>\n` +
          `  </Fixture>`
        );
        ids.push(id);
        address += channels;
        id += 1;
      }
      fixtureGroups.push({ name: type.name, ids, functions: type.functions || [] });
    }

    // 就算这路连接方式这次没有任何灯具，也照样建这个 Universe（只是里面没有
    // Fixture）——保证 Universe ID 跟 CONNECTION_UNIVERSE_ID 的映射关系永远
    // 固定，人工配过的那路输出口不会因为"这次刚好没有 MIDI 灯具"就对不上号。
    const outputPatch = outputPatches[connKey];
    const outputXml = outputPatch
      ? `   <Output Plugin="${escapeXml(outputPatch.plugin)}" Name="${escapeXml(outputPatch.lineName)}" UID="${escapeXml(outputPatch.lineUID || "")}" Line="${outputPatch.line}" />\n`
      : "";
    universeXml.push(
      `   <Universe Name="PIKA-Show ${escapeXml(connKey.toUpperCase())}" ID="${universeId}">\n` +
      outputXml +
      `   </Universe>`
    );
  }

  const { xml: functionsXml, chaseFunctionId } = show
    ? buildShowFunctionsXml(show, fixtureGroups)
    : { xml: "", chaseFunctionId: null };

  const xml = (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE Workspace>\n` +
    `<Workspace CurrentWindow="VirtualConsole">\n` +
    ` <Creator>\n` +
    `  <Name>PIKA-Show</Name>\n` +
    `  <Version>4.12.4</Version>\n` +
    `  <Author>PIKA-Show</Author>\n` +
    ` </Creator>\n` +
    ` <Engine>\n` +
    `  <InputOutputMap>\n` +
    universeXml.join("\n") + "\n" +
    `  </InputOutputMap>\n` +
    fixtureXml.join("\n") + (fixtureXml.length ? "\n" : "") +
    (functionsXml ? functionsXml + "\n" : "") +
    ` </Engine>\n` +
    `</Workspace>\n`
  );

  return { xml, chaseFunctionId };
}

module.exports = { buildWorkspaceXml, buildShowFunctionsXml, placeholderValueForLabel, CONNECTION_UNIVERSE_ID };
