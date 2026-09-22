/**
 * 契约产物层（2026-09-19 S2 第十批 · 从 superModule 巨型闭包里搬出的第十一层）
 * ------------------------------------------------------------------
 * 核心启动时（core:started）写下两份产物，给编辑器与门禁用：
 *   ① data/block-defs.json      —— 块定义（编辑器面板的唯一来源）
 *   ② data/super-contract.json  —— 契约清单与指纹（块/语句/事件/表白名单/错误码 + 块定义 sha1）
 * 设计要点（都是踩过的坑）：
 *   · 参数字段与运行时同口径：只认显式 required:true；min/max 必须带上（数字框上下限靠它）；
 *     JSON.stringify 会丢掉 undefined，所以没写的字段不会多出空键；
 *   · 契约产物只放清单与 sha1，不放整块定义 —— 两边靠指纹关联，避免两份真相；
 *   · 写产物失败只记 warn，绝不影响核心启动。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { differenceEntries } = require('./superDifferences');   // 差异表唯一来源（I1 双面等价）

function createDefsWriter(opts) {
  const o = opts || {};
  const dataDir = o.dataDir || path.join(__dirname, '..', '..', 'data');   // 产物目录（默认：仓库 data/）
  const blocks = o.blocks;                    // 运行时块库（Object: type -> def）
  const statements = o.statements;            // 语句表（S_FLAT / S_BRANCH）
  const events = o.events || [];              // 内置事件清单
  const tables = o.tables || {};              // 表白名单 { query, player, write }
  const errors = o.errors;                    // 错误码登记表（superErrors）
  const log = o.log || (() => {});

  function writeDefinitionArtifacts() {
    try {
      const out = {
        version: 3,
        generatedAt: new Date().toISOString(),
        blocks: Object.keys(blocks).map((t) => {
          const b = blocks[t];
          return {
            type: t, cat: b.cat, name: b.name, color: b.color, desc: b.desc, ports: b.ports,
            // 2026-09-18：与运行时同口径（只认显式 required:true）—— 以前缺省也导成 true，产物里 92/93 个参数全成了必填
            // 2026-09-18 S1：补 min/max（数字框上下限）。以前这两个字段在这条流水线上被丢掉：
            // 定义里有、产物里没有、编辑器 buildBlocks 也拷不到 → 数字框没有约束（契约 K5.6 实测）。
            params: (b.params || []).map((p) => ({ k: p.k, label: p.label, type: p.type, def: p.def, options: p.options, required: p.required === true, help: p.help, min: p.min, max: p.max })),
          };
        }),
      };
      fs.writeFileSync(path.join(dataDir, 'block-defs.json'), JSON.stringify(out, null, 2), 'utf8');
      // 2026-09-18 S1-b · 契约产物：让门禁/工具「读产物」而不是扫源码（治 D5）。
      try {
        const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
        const contract = {
          version: 1,
          generatedAt: out.generatedAt,
          blockDefsVersion: out.version,
          blockDefsSha1: sha1(JSON.stringify(out.blocks)),
          blocks: out.blocks.map((b) => b.type),
          blockCount: out.blocks.length,
          paramCount: out.blocks.reduce((n, b) => n + ((b.params || []).length), 0),
          statements: {
            flat: statements.S_FLAT.map((d) => d.kw),
            branch: statements.S_BRANCH.map((d) => d.kw),
            count: statements.S_FLAT.length + statements.S_BRANCH.length,
          },
          events: events.slice(),
          tables: { query: (tables.query || []).slice(), player: (tables.player || []).slice(), write: (tables.write || []).slice() },
          errors: errors.all(),
          // 2026-09-19 S4 第四批：块模式 ⇄ 代码模式的已知差异（唯一来源 lib/superDifferences.js）
          differences: differenceEntries(),
        };
        fs.writeFileSync(path.join(dataDir, 'super-contract.json'), JSON.stringify(contract, null, 2), 'utf8');
      } catch (e2) { log('warn', '[super] super-contract.json 写入失败: ' + e2.message); }
      log('info', '[super] block-defs.json 已更新（' + Object.keys(blocks).length + ' 块）');
    } catch (e) {
      log('warn', '[super] block-defs.json 写入失败: ' + e.message);
    }
  }

  return { writeDefinitionArtifacts };
}

module.exports = { createDefsWriter };
