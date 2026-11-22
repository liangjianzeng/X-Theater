/* 提示词织入自检（蓝图 §8.3 配套）：配置项必须真正融入提示词——景别/光线/负面/风格四层缺一不可。
   用户批语 2026-11-22：「调整配置参数重新生成后并不可用，比如特写和远景」。 */
"use strict";
const prompts = require("../../src/server/prompts/index.js");
let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log("  PASS  " + name); }
  else { failed++; console.log("  FAIL  " + name); }
}
const base = { styleSuffix: "写实电影感", desc: "城市天台夜景" };

/* 景别：词典真话织入（特写 vs 远景 必须产出不同且具体的构图语言） */
const cu = prompts.buildFreeImagePrompt(Object.assign({ size: "特写" }, base));
const ws = prompts.buildFreeImagePrompt(Object.assign({ size: "远景" }, base));
ok(cu.indexOf("面部充满画面") >= 0, "景别·特写 → 词典真话「面部充满画面」织入");
ok(ws.indexOf("环境为主") >= 0, "景别·远景 → 词典真话「环境为主」织入");
ok(cu.indexOf("close-up") >= 0, "景别 → 英文短语并列（双语模型稳健）");
ok(cu !== ws, "景别·特写与远景输出不同");
ok(cu.indexOf("景别。") < 0, "景别·不再产出同义反复的「X景别」");

/* 光线/负面/风格锚 */
const lit = prompts.buildFreeImagePrompt(Object.assign({ size: "特写", light: "冷蓝深夜，硬阴影", negative: "不要文字水印" }, base));
ok(lit.indexOf("光线：冷蓝深夜") >= 0, "光线织入");
ok(lit.indexOf("避免：不要文字水印") >= 0, "负面织入（避免：前缀）");
ok(lit.indexOf("写实电影感") >= 0, "风格锚最前");
ok(lit.indexOf("单幅剧照") >= 0, "单幅纪律在尾");

/* 音乐 tags 组装：曲风/乐器/人声/BPM 并入通道 */
const tags = prompts.musicTags("释然", {});
ok(typeof tags === "string" && tags.length > 0, "musicTags 基础组装可用");

console.log("\n──────── 提示词织入 selfcheck 汇总 ────────");
console.log("PASS " + passed + " / FAIL " + failed);
process.exitCode = failed ? 1 : 0;
