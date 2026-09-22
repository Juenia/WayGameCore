/**
 * WayGame · 模板键工具（2026-09-16 抽出）
 *
 * 为什么需要它：模块返回的 templateKey 有好几种写法，核心 handleCommand 查库时会自己列变体，
 * 但**模块侧**（图片布局绑定、模板回复模式）以前只拿原样字符串去比对，于是对不上：
 *   itemModule 返回 'item:use.success'（冒号形式）
 *   message_templates 里的键是 'use.success'（无房间前缀、点号形式）
 *   设计器里布局绑定写的是 room='item' + template_key='use.success'
 *   → 结果 (item, 'item:use.success') 查不到，一路回退到 global/default（绑了个寂寞）
 *
 * 本文件把"核心那套变体规则"抽成共享函数，供 modules/lib/image/imageStore.js 与
 * modules/templateModeModule.js 复用，保证模块侧和核心侧认同一批键。
 */
'use strict';

/** 模板键变体（与核心 handleCommand 的 DB-FIRST 查法保持一致，含冒号/点号/短名/去房间前缀） */
function keyVariants(room, templateKey) {
  const out = [];
  const push = (v) => { const s = String(v == null ? '' : v).trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  const raw = String(templateKey == null ? '' : templateKey).trim();
  if (!raw) return out;
  push(raw);                                   // item:use.success
  push(raw.replace(/:/g, '.'));                // item.use.success
  const short = raw.split(':').pop();          // use.success
  push(short);
  push(short.replace(/:/g, '.'));
  const r = String(room == null ? '' : room).trim();
  if (r && raw.indexOf(r + '.') === 0) push(raw.slice(r.length + 1));
  if (r && raw.indexOf(r + ':') === 0) push(raw.slice(r.length + 1));
  return out;
}

/** 规范键：room.key（冒号统一成点号、去掉重复的房间前缀）—— 编辑器/配置表里统一用这一种写法 */
function canonicalKey(room, templateKey) {
  const r = String(room == null ? '' : room).trim();
  let k = String(templateKey == null ? '' : templateKey).trim().replace(/:/g, '.');
  if (!k) return r ? r + '.*' : '';
  if (r && k.indexOf(r + '.') === 0) k = k.slice(r.length + 1);
  return r ? r + '.' + k : k;
}

module.exports = { keyVariants, canonicalKey };
