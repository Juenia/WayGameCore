/**
 * 超级自定义模块 · 块定义【装配】层（2026-09-15 S2 起；2026-09-19 S3 第二批完成分层）
 * ------------------------------------------------------------------
 * 本文件不再持有任何块定义，只做三件事：
 *   ① require 纯助手（superBlockUtil）与取值助手工厂（superBlockKit）
 *   ② 组装 Ctx（助手 + 模块级依赖，注入给各类别文件）
 *   ③ 把 lib/blocks/*.js 十个类别合并成运行时块库并导出
 *
 * 块定义分布（53 块 / 93 参数）：
 *   blocks/flow.js 入口流程 · player.js 玩家数据 · action.js 游戏动作 · query.js 数据查询
 *   output.js 输出调试 · flowx.js 流程扩展 · list.js 列表 · text.js 文本 · num.js 数字
 *   data.js 变量读写 / 数据增删改 / 多轮状态
 *
 * 参数求值策略（三种模式共用）：标识类参数【字面量，不求值】；expr/list【求值】；
 * number【数字字面量，含运算符才求值】。老图兼容：标识类参数带手写引号时自动剥离。
 */
'use strict';
const crypto = require('crypto');
const U = require('./superBlockUtil');
const { createBlockKit } = require('./superBlockKit');
const { createOps } = require('./superOps');   // 2026-09-19 S3+：语句唯一实现（块与代码共用一份动作）

function defineBlocks(core, deps) {
  const kit = createBlockKit({ core, deps, util: U });
  const ops = createOps({ core });   // 语句唯一实现层（块侧适配器调它，代码侧也调同一份）
  // Ctx = 各类别文件能用到的全部外部能力（纯助手 + 取值助手 + 模块级依赖 + 语句动作）
  const Ctx = Object.assign({
    invokeLogic: deps.invokeLogic,
    stateEnter: deps.stateEnter,
    stateExit: deps.stateExit,
    crypto,
    ops,
  }, U, kit);

  return Object.assign({},
    require('./blocks/flow')(Ctx, core, deps),
    require('./blocks/player')(Ctx, core, deps),
    require('./blocks/action')(Ctx, core, deps),
    require('./blocks/query')(Ctx, core, deps),
    require('./blocks/output')(Ctx, core, deps),
    require('./blocks/flowx')(Ctx, core, deps),
    require('./blocks/list')(Ctx, core, deps),
    require('./blocks/text')(Ctx, core, deps),
    require('./blocks/num')(Ctx, core, deps),
    require('./blocks/data')(Ctx, core, deps),
  );
}

// 导出面保持不变（superCode.js 直接 require 这里的写操作助手，2026-09-18 起共用同一套）
module.exports = Object.assign({ defineBlocks }, U);
