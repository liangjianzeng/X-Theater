"use strict";
/* 数据自检审计（蓝图 §8.4 门禁①②）：node test/acceptance/data-audit.js
   扫 var/state.json 的用户面文本字段——
   ①编码门：U+FFFD 替换符/控制字符/孤立代理对（乱码入库）
   ②重复门：同域候选池内完全重复的描述（一次多点/重复提交的废品）
   ③测试残留门：已知测试标记短语（链路测试/算力池验收）残留在生产数据
   发现即退出码 1（可作提交前门禁）；用户数据只报告不自动删。 */
const fs = require("fs");
const path = require("path");

const STATE = path.join(__dirname, "..", "..", "var", "state.json");
const st = JSON.parse(fs.readFileSync(STATE, "utf8"));

const TEXT_KEYS = ["desc", "title", "prompt", "dialogue", "text", "name", "note", "reason", "summary", "reply", "brief"];
const TEST_MARKERS = ["链路测试", "算力池验收", "意图回归", "pool-test", "selfcheck-marker"];
const issues = [];
const seenPaths = [];

function badChars(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c === 0xfffd || (c >= 0x00 && c <= 0x08) || (c >= 0x0e && c <= 0x1f) || (c >= 0xd800 && c <= 0xdfff)) n++;
  }
  return n;
}
function walk(obj, p) {
  if (obj == null) return;
  if (Array.isArray(obj)) { obj.forEach((v, i) => walk(v, p + "[" + i + "]")); return; }
  if (typeof obj === "object") {
    if (seenPaths.indexOf(p) >= 0) return; // 防循环引用
    seenPaths.push(p);
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (typeof v === "string") {
        if (TEXT_KEYS.indexOf(k) >= 0) {
          const bad = badChars(v);
          if (bad > 0) issues.push({ gate: "编码", path: p + "." + k, detail: "含 " + bad + " 个替换/控制字符", sample: v.replace(/[^\x20-\x7e]/g, "¤").slice(0, 40) });
          TEST_MARKERS.forEach((m) => {
            if (v.indexOf(m) >= 0) issues.push({ gate: "测试残留", path: p + "." + k, detail: "含测试标记「" + m + "」", sample: v.slice(0, 40) });
          });
        }
      } else walk(v, p + "." + k);
    });
  }
}
walk(st, "$");

/* 重复门：候选池同域内完全重复 desc */
["images", "audio", "music", "characters", "scenes"].forEach((dom) => {
  const arr = (st.asset_drafts || {})[dom] || [];
  const groups = {};
  arr.forEach((x) => {
    const key = String(x.desc || x.prompt || "").trim();
    if (!key) return;
    (groups[key] = groups[key] || []).push(x.id || "?");
  });
  Object.keys(groups).forEach((key) => {
    if (groups[key].length > 1) issues.push({ gate: "重复", path: "asset_drafts." + dom, detail: "同描述候选 ×" + groups[key].length + "（" + key.slice(0, 24) + "…）", ids: groups[key] });
  });
});

console.log("数据自检审计 —— " + (issues.length ? issues.length + " 个问题" : "干净"));
issues.forEach((i) => console.log("  [" + i.gate + "] " + i.path + " " + i.detail + (i.sample ? "  样本:「" + i.sample + "」" : "") + (i.ids ? " ids=" + i.ids.join(",") : "")));
process.exitCode = issues.length ? 1 : 0;
