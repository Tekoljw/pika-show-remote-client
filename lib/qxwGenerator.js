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
 * 精确度取决于灯光库里这个白话功能有没有配置过 channelValues（见"灯光库"
 * 详情页里点一个白话功能 chip 打开的通道映射编辑器，types.ts 的
 * FixtureFunction.channelValues）：
 *   - 配置过：只对"拥有这个功能"的那个型号的所有台数生效，按真实通道号(1-based，
 *     跟原厂手册一致)+真实数值设置，其它型号不受影响。
 *   - 没配置过：退回 placeholderValueForLabel 的占位效果，且作用于全部已知灯具——
 *     这是因为 ShowEvent.deviceIds 精确指向哪几台灯目前还没法在这一层解析
 *     （venueFixtures 同步到 PC 之后没有保留 FixtureInstance 级别的 ID，这是
 *     独立于通道映射之外的另一个已知缺口，留给后续解决）。
 *
 * @param {{ id: string, displayName?: string, fileName?: string, events: Array<{id:string,time:number,functionLabel:string}> }} show
 * @param {{ ids: number[], functions: Array<{ label: string, channelValues?: Array<{channel:number,value:number}> }> }[]} fixtureGroups
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
    const fixtureValsXml = fixtureGroups
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

/**
 * @param {{ name: string, channels: number, quantity: number, functions?: Array<{label:string,channelValues?:Array<{channel:number,value:number}>}> }[]} fixtureTypes
 *   每个型号需要知道:通道数(每台占用几个 DMX 地址，调用方应该已经把这个型号任何
 *   functions.channelValues 用到的最大通道号也算进去了，不然精确映射会指向一个
 *   Generic 灯具压根没有的通道)、台数、可选的白话功能→通道映射(来自灯光库详情页)。
 * @param {{ plugin: string, lineName: string, lineUID?: string, line: number }|null} [outputPatch]
 *   Universe 0 要绑定到哪个真实输出口——这个信息只有连了真实硬件之后才知道
 *   具体是哪一路，生成方案时如果还不知道就传 null，先不写 <Output> 标签，
 *   之后再由人工在 QLC+ 里配一次（一次性的，不是每次都要配）。
 * @param {object|null} [show] 可选——同时把一个方案的时间轴翻译成 Function 写进同一份工作区。
 * @returns {{ xml: string, chaseFunctionId: number|null }}
 */
function buildWorkspaceXml(fixtureTypes, outputPatch = null, show = null) {
  let address = 0;
  let id = 0;
  const fixtureXml = [];
  const fixtureGroups = []; // 按型号分组的 Fixture ID，供 buildShowFunctionsXml 按型号匹配白话功能

  for (const type of fixtureTypes) {
    const channels = Math.max(1, Math.min(512, type.channels || 1));
    const ids = [];
    for (let i = 0; i < type.quantity; i++) {
      if (address + channels > 512) {
        // 超出一个 universe(512 通道)的部分先跳过，不静默截断数据也不崩溃——
        // 多 universe 支持是后续需要的时候再加，现在先如实反映"装不下"。
        break;
      }
      fixtureXml.push(
        `  <Fixture>\n` +
        `   <Manufacturer>Generic</Manufacturer>\n` +
        `   <Model>Generic</Model>\n` +
        `   <Mode>Generic</Mode>\n` +
        `   <ID>${id}</ID>\n` +
        `   <Name>${escapeXml(type.name)} #${i + 1}</Name>\n` +
        `   <Universe>0</Universe>\n` +
        `   <Address>${address}</Address>\n` +
        `   <Channels>${channels}</Channels>\n` +
        `  </Fixture>`
      );
      ids.push(id);
      address += channels;
      id += 1;
    }
    fixtureGroups.push({ ids, functions: type.functions || [] });
  }

  const outputXml = outputPatch
    ? `   <Output Plugin="${escapeXml(outputPatch.plugin)}" Name="${escapeXml(outputPatch.lineName)}" UID="${escapeXml(outputPatch.lineUID || "")}" Line="${outputPatch.line}" />\n`
    : "";

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
    `   <Universe Name="PIKA-Show Universe 1" ID="0">\n` +
    outputXml +
    `   </Universe>\n` +
    `  </InputOutputMap>\n` +
    fixtureXml.join("\n") + (fixtureXml.length ? "\n" : "") +
    (functionsXml ? functionsXml + "\n" : "") +
    ` </Engine>\n` +
    `</Workspace>\n`
  );

  return { xml, chaseFunctionId };
}

module.exports = { buildWorkspaceXml, buildShowFunctionsXml, placeholderValueForLabel };
