/**
 * 块定义 · 变量读写 / 数据增删改 / 多轮状态（2026-09-19 S3 第一批：从 superBlocks.js 的巨型对象里整块搬出）
 * ------------------------------------------------------------------
 * 本文件只有【块定义元数据 + 每块的 run 实现】；取值助手由 superBlocks 通过 Ctx 注入。
 * 搬出方式：整块剪切 + 统一给助手调用加 Ctx. 前缀 —— 行为零变更。
 * 新增块：在本文件对应类别里加一条即可，不必再读 900 行的巨无霸。
 */
'use strict';

module.exports = function (Ctx, core, deps) {
  return {
    var_get: {
      cat: '数据', name: '读取变量', color: '#3DC5C5', desc: '读系统/自定义变量（主库 variables 表）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '变量名', type: 'text', def: '', required: true, help: '不用写方括号；系统变量可写 系统.名字，也可直接写名字' },
      ],
      run: async (n, ctx, E) => {
        const raw = String(Ctx.lit(n, 'name', '')).trim().replace(/^系统\./, '');
        if (!raw) { const e = new Error('「读取变量」没写变量名'); e.code = 'E_ARGS'; throw e; }
        const isSystem = !!(core.systemVariables && typeof core.systemVariables.has === 'function' && core.systemVariables.has(raw));
        const isCustom = !!(core.customVariables && typeof core.customVariables.has === 'function' && core.customVariables.has(raw));
        const v = await core.getVariableValue(raw, ctx.playerId, 0, ctx.data || {});
        if ((v === undefined || v === null || v === '') && !isSystem && !isCustom) {
          const known = (core.customVariables && typeof core.customVariables.keys === 'function') ? Array.from(core.customVariables.keys()).slice(0, 12) : [];
          const e = new Error('没有叫「' + raw + '」的变量' + (known.length ? '（现有自定义变量：' + known.join('、') + '…）' : '（现在还没有任何自定义变量）') + ' —— 先建一个，或者检查名字有没有写错');
          e.code = 'E_NOTFOUND'; throw e;
        }
        ctx.data['变量值'] = v;
        return { nextPort: 'next', output: v };
      },
    },
    var_set: {
      cat: '数据', name: '设置变量', color: '#3DC5C5', desc: '新建/改写自定义变量：内存即时生效 + 落库',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '变量名', type: 'text', def: '', required: true, help: '不能与系统变量重名' },
        { k: 'value', label: '值', type: 'expr', def: '', help: '表达式；纯文本要加引号' },
        { k: 'desc', label: '说明(可选)', type: 'text', def: '' },
      ],
      run: async (n, ctx, E) => {
        const name = String(Ctx.lit(n, 'name', '')).trim().replace(/^系统\./, '');
        if (!name) { const e = new Error('「设置变量」没写变量名'); e.code = 'E_ARGS'; throw e; }
        if (core.systemVariables && typeof core.systemVariables.has === 'function' && core.systemVariables.has(name)) {
          const e = new Error('「' + name + '」是系统变量（模块提供，只读）—— 换一个名字'); e.code = 'E_SYSVAR'; throw e;
        }
        const rawSrc = (n.params && n.params.value !== undefined && n.params.value !== null) ? String(n.params.value).trim() : '';
        // 2026-09-18 实测：值里写「你好，[玩家昵称]！」时表达式引擎会直接抛「认不出 [」，整条逻辑失败、变量根本没写。
        // 这里先兜住求值异常，再用核心模板渲染拿一次显示值 —— 写变量不该因为"值长得像文本"就整条挂掉。
        let v = null;
        try { v = await Ctx.exprValue(n, 'value', '', E, ctx); } catch (e) { v = null; }
        if ((v === null || v === undefined || v === '') && /[\[{]/.test(rawSrc)) {
          try {
            const rr = await core.renderTemplate(rawSrc, ctx.data || {}, { escape: false }, ctx.playerId || null, null);
            const rt = String(rr == null ? '' : rr).trim();
            if (rt && rt !== rawSrc) v = rt;
          } catch (e) { /* 渲染失败就按原文本处理 */ }
        }
        const desc = String(Ctx.lit(n, 'desc', '') || '');
        // 入库形式按核心的口径规范化（纯文本套引号 / 带 [变量] 的文本转拼接式 / 公式原样）
        const store = Ctx.normalizeVarValue(rawSrc, v);
        // 走核心写通道：内存即时生效（getVariableValue 读的就是内存），再 await 一次落库，保证「写完立刻读」也对
        await core.setCustomVariable(name, store, desc);
        try { await core.db.saveVariable(name, store, desc); } catch (e) { try { core.log('warn', '[super] 变量落库失败: ' + e.message); } catch (e2) {} }
        const shown = (v === null || v === undefined) ? '' : (typeof v === 'object' ? JSON.stringify(v) : v);
        ctx.data['变量值'] = shown;
        return { nextPort: 'next', output: shown };
      },
    },
    var_del: {
      cat: '数据', name: '删除变量', color: '#3DC5C5', desc: '删掉自定义变量（内存与库一起删）；删到了走真，本来没有走假',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'name', label: '变量名', type: 'text', def: '', required: true }],
      run: async (n, ctx) => {
        const name = String(Ctx.lit(n, 'name', '')).trim().replace(/^系统\./, '');
        if (!name) { const e = new Error('「删除变量」没写变量名'); e.code = 'E_ARGS'; throw e; }
        if (core.systemVariables && typeof core.systemVariables.has === 'function' && core.systemVariables.has(name)) {
          const e = new Error('「' + name + '」是系统变量（模块提供，删不掉）'); e.code = 'E_SYSVAR'; throw e;
        }
        let existed = false;
        try { existed = !!(await core.db.getVariable(name)); } catch (e) { existed = false; }
        if (core.customVariables && typeof core.customVariables.delete === 'function') {
          if (core.customVariables.delete(name)) existed = true;
        }
        try { await core.db.deleteVariable(name); } catch (e) { const er = new Error('删除变量失败：' + e.message); er.code = 'E_DB'; throw er; }
        return { nextPort: 'next', output: existed };   // 布尔结果作为节点输出，要分支就用「如果」判断
      },
    },
    data_create: {
      cat: '数据', name: '新建数据', color: '#E8A84A', desc: '往内容表插入一行（表白名单 + 字段体检，写错一律人话报错）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'table', label: '表', type: 'select', def: 'items', options: 'queryTables', required: true },
        { k: 'fields', label: '字段(字段=值；多个用分号隔开)', type: 'text', def: '', required: true, help: '例：name=新手剑; category=武器; type=消耗品' },
      ],
      run: async (n, ctx, E) => {
        const table = Ctx.lit(n, 'table', 'items');
        const pairs = await Ctx.parseFieldPairs(n.params && n.params.fields, E, ctx);
        if (!pairs.length) { const e = new Error('「新建数据」至少要写一个 字段=值'); e.code = 'E_ARGS'; throw e; }
        const info = await Ctx.checkWrite(table, pairs);
        if (!info.pk) { const e = new Error('表 ' + table + ' 没有主键，不能新建'); e.code = 'E_TABLE'; throw e; }
        const pkPair = pairs.find((p) => p.col === info.pk);
        if (!pkPair) { const e = new Error('新建数据必须给出主键字段「' + info.pk + '」（例：' + info.pk + '=名字）'); e.code = 'E_ARGS'; throw e; }
        const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [pkPair.val]);
        if (existed) { const e = new Error('表 ' + table + ' 里已经有「' + pkPair.val + '」了 —— 要改它请用「修改数据」'); e.code = 'E_EXISTS'; throw e; }
        const cols = pairs.map((p) => p.col);
        await core.db.run('INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')', pairs.map((p) => p.val));
        ctx.data['数据'] = { 表: table, 主键: info.pk, 值: pkPair.val, 操作: '新建' };
        return { nextPort: 'next', output: pkPair.val };
      },
    },
    data_update: {
      cat: '数据', name: '修改数据', color: '#E8A84A', desc: '按主键改内容表里的一行（只改你写出来的字段）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'table', label: '表', type: 'select', def: 'items', options: 'queryTables', required: true },
        { k: 'rowKey', label: '主键值(要改哪一行)', type: 'expr', def: '', required: true, help: '例："新手剑" 或 参数.1' },
        { k: 'fields', label: '字段(字段=值；多个用分号隔开)', type: 'text', def: '', required: true },
      ],
      run: async (n, ctx, E) => {
        const table = Ctx.lit(n, 'table', 'items');
        const pairs = await Ctx.parseFieldPairs(n.params && n.params.fields, E, ctx);
        if (!pairs.length) { const e = new Error('「修改数据」没写要改成什么（字段=值）'); e.code = 'E_ARGS'; throw e; }
        const info = await Ctx.checkWrite(table, pairs);
        const keyVal = await Ctx.exprText(n, 'rowKey', '', E, ctx);   // 主键值可以是表达式（参数.1 这类）
        if (keyVal === '' || keyVal === null || keyVal === undefined) { const e = new Error('「修改数据」没写主键值（要改哪一行）'); e.code = 'E_ARGS'; throw e; }
        const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [keyVal]);
        if (!existed) { const e = new Error('表 ' + table + ' 里没有「' + keyVal + '」这一行（主键 ' + info.pk + '）'); e.code = 'E_NOTFOUND'; throw e; }
        await core.db.run('UPDATE ' + table + ' SET ' + pairs.map((p) => p.col + ' = ?').join(', ') + ' WHERE ' + info.pk + ' = ?', pairs.map((p) => p.val).concat([keyVal]));
        ctx.data['数据'] = { 表: table, 主键: info.pk, 值: keyVal, 操作: '修改' };
        return { nextPort: 'next', output: keyVal };
      },
    },
    data_delete: {
      cat: '数据', name: '删除数据', color: '#E8A84A', desc: '按主键删内容表里的一行（找不到就人话报错，不静默）',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'table', label: '表', type: 'select', def: 'items', options: 'queryTables', required: true },
        { k: 'rowKey', label: '主键值(删哪一行)', type: 'expr', def: '', required: true },
      ],
      run: async (n, ctx, E) => {
        const table = Ctx.lit(n, 'table', 'items');
        const info = await Ctx.checkWrite(table, []);
        const keyVal = await Ctx.exprText(n, 'rowKey', '', E, ctx);   // 主键值可以是表达式（参数.1 这类）
        if (keyVal === '' || keyVal === null || keyVal === undefined) { const e = new Error('「删除数据」没写主键值（删哪一行）'); e.code = 'E_ARGS'; throw e; }
        const existed = await core.db.get('SELECT * FROM ' + table + ' WHERE ' + info.pk + ' = ? LIMIT 1', [keyVal]);
        if (!existed) { const e = new Error('表 ' + table + ' 里没有「' + keyVal + '」这一行（主键 ' + info.pk + '）'); e.code = 'E_NOTFOUND'; throw e; }
        await core.db.run('DELETE FROM ' + table + ' WHERE ' + info.pk + ' = ?', [keyVal]);
        ctx.data['数据'] = { 表: table, 主键: info.pk, 值: keyVal, 操作: '删除' };
        return { nextPort: 'next', output: keyVal };
      },
    },
    enter_state: {
      cat: '流程', name: '进入状态', color: '#E8A84A', desc: '多轮状态：玩家下一条消息（不管内容）都回到本条逻辑，原文进 [输入]',
      ports: { in: true, out: ['next'] },
      params: [
        { k: 'name', label: '状态名', type: 'text', def: '对话', required: true, help: '给人看的名字；逻辑里可用 [状态名] 取' },
        { k: 'timeout', label: '超时(秒，0=不过期)', type: 'number', def: '0' },
      ],
      run: async (n, ctx, E) => {
        Ctx.needPlayerId(ctx, '进入状态');
        const nm = String(Ctx.lit(n, 'name', '')).trim() || '对话';
        const sec = await Ctx.numOf(n, 'timeout', 0, E, ctx);
        if (typeof Ctx.stateEnter !== 'function') { const e = new Error('状态路由没接上（模块没注入 Ctx.stateEnter）'); e.code = 'E_INTERNAL'; throw e; }
        await Ctx.stateEnter(ctx.playerId, { logicKey: ctx.key, name: nm, timeoutSec: Number(sec) || 0 });
        ctx.data['状态名'] = nm;
        return { nextPort: 'next', output: nm };
      },
    },
    exit_state: {
      cat: '流程', name: '结束状态', color: '#E8A84A', desc: '结束多轮状态（留空=结束该玩家当前的状态）',
      ports: { in: true, out: ['next'] },
      params: [{ k: 'name', label: '状态名(留空=全部结束)', type: 'text', def: '' }],
      run: async (n, ctx) => {
        if (!ctx.playerId) return { nextPort: 'next', output: false };
        if (typeof Ctx.stateExit !== 'function') return { nextPort: 'next', output: false };
        const nm = String(Ctx.lit(n, 'name', '')).trim();
        const done = await Ctx.stateExit(ctx.playerId, nm);
        ctx.data['状态名'] = '';
        return { nextPort: 'next', output: done };
      },
    },
  };
};
