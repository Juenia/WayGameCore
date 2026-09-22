/**
 * 背包系统模块 - 处理物品存储、查看、筛选、丢弃与使用入口
 */
async function backpackModule(core) {
  core.log('info', '正在加载背包系统模块...');

  // 1. 检查依赖
  if (!core.db) {
    throw new Error('背包模块加载失败：数据库模块未就绪。');
  }

  // 2. 分类注册管理
  const categoryRegistry = new Map();
  
  const backpackSystem = {
    /**
     * 注册分类
     */
    registerCategory: (category, sourceModule) => {
      categoryRegistry.set(category, sourceModule);
      core.log('info', `背包系统已注册分类: [${category}] (来源: ${sourceModule})`);
    },

    /**
     * 获取所有已注册分类
     */
    getAllCategories: () => {
      return Array.from(categoryRegistry.keys());
    },

    /**
     * 添加物品到玩家背包
     */
    addItem: async (playerId, itemName, quantity = 1, servicesOrCore, category) => {
      const svc = (servicesOrCore && servicesOrCore.player) ? servicesOrCore : core.services;
      return await svc.player.giveItems({
        targets: [playerId],
        items: [{ name: itemName, count: quantity }],
        source: 'backpack:addItem'
      });
    },

    /**
     * 从玩家背包移除物品
     */
    removeItem: async (playerId, itemName, quantity = 1, servicesOrCore) => {
      const svc = (servicesOrCore && servicesOrCore.player) ? servicesOrCore : core.services;
      return await svc.player.takeItems({
        playerId,
        items: [{ name: itemName, count: quantity }],
        source: 'backpack:removeItem'
      });
    },

    /**
     * 获取玩家背包中指定物品的数量
     */
    getItemCount: async (playerId, itemName) => {
      const player = await core._playerService.get(playerId);
      if (!player || !player.背包) return 0;
      return player.背包[itemName] || 0;
    },

    /**
     * 提交物品 (用于任务等)
     */
    submitItem: async (playerId, itemName, quantity = 1) => {
      const success = await backpackSystem.removeItem(playerId, itemName, quantity);
      if (success) {
        await core.emit('backpack:item_submitted', playerId, itemName, quantity);
        return true;
      }
      return false;
    }
  };



  // 3. 监听拾取事件
  core.on('item:picked_up', async (playerId, itemName, mapName) => {
    core.log('info', `[BACKPACK] 收到拾取事件: 玩家=${playerId}, 物品=${itemName}, 地图=${mapName}`);
    
    // 检查物品是否存在 (同时检查 item 和 equipment 系统)
    const itemDef = core.item?.getDefinition(itemName) || core.equipment?.getDefinition(itemName);
    if (!itemDef) {
      core.log('warn', `[BACKPACK] 玩家 ${playerId} 拾取了未定义的物品: "${itemName}"。请检查数据库定义。`);
      return;
    }

    // 确保从核心状态获取最新的玩家数据
    const player = await core._playerService.get(playerId);
    if (!player) {
      core.log('warn', `背包系统找不到玩家数据: ${playerId}`);
      return;
    }

    // 初始化背包
    if (!player.背包) {
      player.背包 = {};
    }

    // 增加数量
    const newBackpack = { ...player.背包, [itemName]: (player.背包[itemName] || 0) + 1 };

    try {
      await core._playerService.modify({ playerId, changes: { 背包: newBackpack }, source: 'backpack:item_picked_up' });
      
      await core.emit('backpack:item_added', playerId, itemName, 1);
      core.log('info', `玩家 ${playerId} 背包已成功存入: ${itemName}，当前数量: ${newBackpack[itemName]}`);
    } catch (err) {
      core.log('error', `玩家背包数据保存失败: ${err.message}`);
    }
  });

  // 4. 指令逻辑处理器实现

  // 挂载到核心供 itemModule 等调用
  core.backpack = backpackSystem;

  // 如果 itemModule 已加载，尝试注册其分类
  const itemMod = core.getModule('item');
  if (itemMod && itemMod.registerItemCategories) {
    itemMod.registerItemCategories();
  }

  const doors = [
    { logical_name: 'backpack:view', default_triggers: ['查看背包', 'b', 'bag', 'bb'], description: '查看背包物品' },
    { logical_name: 'backpack:filter', default_triggers: ['筛选'], description: '按类型筛选背包物品' },
    { logical_name: 'backpack:drop', default_triggers: ['丢弃', 'drop', 'dq'], description: '丢弃背包中的物品' },
    { logical_name: 'backpack:item_info', default_triggers: ['查询物品', 'item', 'cxwp'], description: '查看物品详细信息' },
    { logical_name: 'backpack:submit', default_triggers: ['提交物品', 'submit', 'tjwp'], description: '提交物品以完成任务' },
    { logical_name: 'backpack:add_item', default_triggers: ['添加物品', 'additem'], description: '添加物品到背包 (GM命令)' }
  ];

  const templates = {
    'backpack:view.empty': { text: '你的背包空空如也。', markdown: '你的背包空空如也。' },
    'backpack:view.success': { text: '--- 背包 ---\n[背包全部数据]', markdown: '--- 背包 ---\n[背包全部数据]' },
    'backpack:filter.success': { text: '--- 筛选: {type} ---\n[背包筛选数据]', markdown: '--- 筛选: {type} ---\n[背包筛选数据]' },
    'backpack:drop.success': { text: '你丢弃了 {quantity} 个 {itemName}。', markdown: '你丢弃了 **{quantity}** 个 **{itemName}**。' },
    'backpack:item_info.success': { text: '【[物品名]】\n分类：[物品分类]\n类型：[物品类型]\n描述：[物品介绍]', markdown: '【**[物品名]**】\n分类：[物品分类]\n类型：[物品类型]\n描述：[物品介绍]' },
    'backpack:submit.success': { text: '你成功提交了 {itemName} x{quantity}。', markdown: '你成功提交了 **{itemName}** x**{quantity}**。' },
    'backpack:add_item.success': { text: '已为玩家 {player.昵称} 添加 {itemName} x{quantity}。', markdown: '已为玩家 **{player.昵称}** 添加 **{itemName}** x**{quantity}**。' }
  };

  // 按消息模式读 UI 模板（从 message_templates 表，不硬编码）
  const uiMode = () => (String(core.state.settings?.message_mode ?? '1') === '2') ? 'md' : 'text';
  const getUiTpl = async (baseKey) => {
    try {
      const fullKey = baseKey + '.' + uiMode();
      const parts = fullKey.split('.');
      const row = await core.db.getMessageTemplate(parts[0], parts.slice(1).join('.'));
      if (!row) return '';
      return (uiMode() === 'md' ? row.markdown_content : row.text_content) || '';
    } catch (e) { return ''; }
  };

  // 构造背包行列表（模板全部来自 message_templates）
  const buildLines = async (items, playerId) => {
    const tplEquip = await getUiTpl('ui.btn.equip');
    const tplUse = await getUiTpl('ui.btn.use');
    const lineTpl = (await getUiTpl('ui.backpack.line')) || '{name} x{count} {btn}';
    const lines = [];
    for (const { name, count } of items) {
      let def = null;
      try { if (core.item) def = await core.item.getDefinition(name); } catch (e) {}
      if (!def && core.equipment) { try { def = await core.equipment.getDefinitionAsync(name); } catch (e) {} }
      const isEquip = !!(def && (def.category === '装备' || def.slot_id));
      const btnTpl = isEquip ? tplEquip : tplUse;
      // 走通用渲染：用户模板里可用 {itemName} {name} {itemNameEnc} {count} {category} {slot} 等任意 data 字段
      const _btnData = { itemName: name, name: name, itemNameEnc: encodeURIComponent(name) };
      if (typeof count !== 'undefined') _btnData.count = count;
      if (def) { _btnData.category = def.category || ''; _btnData.slot = def.slot_id || ''; }
      const btn = btnTpl ? await core.renderUiTpl(btnTpl, _btnData, playerId) : '';
      const _lineData = { name, count, btn };
      lines.push(await core.renderUiTpl(lineTpl, _lineData, playerId));
    }
    return lines.join('\n');
  };

  const handlers = {
    'backpack:view': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const backpack = player.背包 || {};
      if (Object.keys(backpack).length === 0) {
        return { status: 'empty', data: {}, templateKey: 'backpack:view.empty' };
      }

      const 页码 = Math.max(1, parseInt(args && args[0]) || 1);
      const 每页 = 5;
      const entries = Object.entries(backpack);
      const 总页数 = Math.ceil(entries.length / 每页);
      const 实际页码 = Math.min(页码, 总页数);
      const start = (实际页码 - 1) * 每页;
      const pageItems = entries.slice(start, start + 每页);

      const tplEquip = await getUiTpl('ui.btn.equip');
      const tplUse = await getUiTpl('ui.btn.use');

      const data = { 页码: 实际页码, 总页数, 背包: backpack };
      for (let i = 0; i < 每页; i++) {
        if (i < pageItems.length) {
          const [name, count] = pageItems[i];
          let def = null;
          try { if (core.item) def = await core.item.getDefinition(name); } catch (e) {}
          if (!def && core.equipment) { try { def = await core.equipment.getDefinitionAsync(name); } catch (e) {} }
          const isEquip = !!(def && (def.category === '装备' || def.slot_id));
          const btnTpl = isEquip ? tplEquip : tplUse;
          // 走通用渲染：用户模板里可用 {itemName} {name} {itemNameEnc} {count} {category} {slot} 等任意 data 字段
          const _btnData = { itemName: name, name: name, itemNameEnc: encodeURIComponent(name) };
          if (typeof count !== 'undefined') _btnData.count = count;
          if (def) { _btnData.category = def.category || ''; _btnData.slot = def.slot_id || ''; }
          const btn = btnTpl ? await core.renderUiTpl(btnTpl, _btnData, playerId) : '';
          data['列表' + (i + 1)] = { 名: name, 数量: count, 按钮: btn };
        } else {
          data['列表' + (i + 1)] = null;
        }
      }

      // 翻页按钮走 UI 模板（2026-09-17）：和「装备 / 使用」按钮同一套机制，编辑器里可改。
      // 原来写死 <qqbot-cmd-input>，图片通道会把标签源码原样印到卡片上。
      const tplPrev = await getUiTpl('ui.btn.prev');
      const tplNext = await getUiTpl('ui.btn.next');
      const buildPageBtn = async (tpl, 目标页) => {
        if (!tpl || !目标页) return '';
        const 命令 = '背包 ' + 目标页;
        return await core.renderUiTpl(tpl, {
          页: 目标页, 总页数, 命令,
          cmd: 命令, cmdEnc: encodeURIComponent(命令),
          itemNameEnc: encodeURIComponent(命令),   // 兼容老模板写法
        }, playerId);
      };
      data.上一页 = await buildPageBtn(tplPrev, 实际页码 > 1 ? 实际页码 - 1 : 0);
      data.下一页 = await buildPageBtn(tplNext, 实际页码 < 总页数 ? 实际页码 + 1 : 0);

      return { status: 'success', data, templateKey: 'backpack:view.success' };
    },

    'backpack:filter': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) {
        return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
      }

      const type = args[0];
      if (!type) return { status: 'fail_no_type', data: {}, templateKey: 'system.invalid_command_args' }; // 或者更具体的模板

      const filteredItems = [];
      const isAll = type === '全部' || type === '所有' || type === 'all';

      for (const [name, count] of Object.entries(player.背包 || {})) {
        if (isAll) {
          filteredItems.push({ name, count });
          continue;
        }

        let def = null;
        if (core.item) {
          def = await core.item.getDefinition(name);
        }
        if (!def && core.equipment) {
          def = await core.equipment.getDefinitionAsync(name);
        }

        if (def && (def.category === type || def.type === type || def.slot_id === type || (type === '装备' && (def.category === '装备' || def.slot_id)))) {
          filteredItems.push({ name, count });
        }
      }
      const tplEquip = await getUiTpl('ui.btn.equip');
      const tplUse = await getUiTpl('ui.btn.use');
      const lineTpl = (await getUiTpl('ui.backpack.line')) || '{name} x{count} {btn}';
      const filterLines = [];
      for (const it of filteredItems) {
        let fdef = null;
        try { if (core.item) fdef = await core.item.getDefinition(it.name); } catch (e) {}
        if (!fdef && core.equipment) { try { fdef = await core.equipment.getDefinitionAsync(it.name); } catch (e) {} }
        const isE = !!(fdef && (fdef.category === '装备' || fdef.slot_id));
        const btnTpl = isE ? tplEquip : tplUse;
        // 走通用渲染：用户模板里可用 {itemName} {name} {itemNameEnc} {count} {category} {slot} 等任意 data 字段
        const _btnData = { itemName: it.name, name: it.name, itemNameEnc: encodeURIComponent(it.name) };
        if (it.count !== undefined) _btnData.count = it.count;
        if (fdef) { _btnData.category = fdef.category || ''; _btnData.slot = fdef.slot_id || ''; }
        const btn = btnTpl ? await core.renderUiTpl(btnTpl, _btnData, playerId) : '';
        const _lineData = { name: it.name, count: it.count, btn };
        filterLines.push(await core.renderUiTpl(lineTpl, _lineData, playerId));
      }
      return { status: 'success', data: { type, filteredItems, '背包筛选数据': filterLines.join('\n') }, templateKey: 'backpack:filter.success' };
    },

    'backpack:drop': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) {
        return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
      }

      const itemName = args[0];
      const quantity = parseInt(args[1] || '1');

      if (!itemName) return { status: 'fail_no_item', data: {}, templateKey: 'system.invalid_command_args' };
      if (isNaN(quantity) || quantity <= 0) return { status: 'fail_invalid_quantity', data: {}, templateKey: 'system.invalid_command_args' };

      const success = await backpackSystem.removeItem(playerId, itemName, quantity);
      if (!success) return { status: 'fail_not_enough', data: { itemName }, templateKey: 'backpack:drop.fail_not_enough' };

      await core.emit('backpack:item_dropped', playerId, itemName, quantity);
      
      return { status: 'success', data: { itemName, quantity }, templateKey: 'backpack:drop.success' };
    },

    'backpack:item_info': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) {
        return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
      }
      
      const itemName = args[0];
      if (!itemName) return { status: 'fail_no_item', data: {}, templateKey: 'system.invalid_command_args' };
 
      // 通过 item 模块获取定义（异步）
      const itemMod = core.getModule('item');
      let def = null;
      if (itemMod && itemMod.getDefinition) {
        def = await itemMod.getDefinition(itemName);
      }
      if (!def) {
        return { status: 'fail_not_found', data: { itemName }, templateKey: 'backpack:item_info.fail_not_found' };
      }
 
      return {
        status: 'success',
        data: {
          物品名: def.name,
          物品分类: def.category,
          物品类型: def.type || '无',
          物品介绍: def.description || '无介绍'
        },
        templateKey: 'backpack:item_info.success'
      };
    },

    'backpack:submit': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) {
        return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
      }

      const itemName = args[0];
      const quantity = parseInt(args[1] || '1');

      if (!itemName) return { status: 'fail_no_item', data: {}, templateKey: 'system.invalid_command_args' };
      if (isNaN(quantity) || quantity <= 0) return { status: 'fail_invalid_quantity', data: {}, templateKey: 'system.invalid_command_args' };

      const success = await backpackSystem.submitItem(playerId, itemName, quantity);
      if (!success) return { status: 'fail_not_enough', data: { itemName }, templateKey: 'backpack:submit.fail_not_enough' };

      return { status: 'success', data: { itemName, quantity }, templateKey: 'backpack:submit.success' };
    },

    'backpack:add_item': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) {
        return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
      }

      const itemName = args[0];
      const quantity = parseInt(args[1] || '1');

      if (!itemName) return { status: 'fail_no_item', data: {}, templateKey: 'system.invalid_command_args' };
      if (isNaN(quantity) || quantity <= 0) return { status: 'fail_invalid_quantity', data: {}, templateKey: 'system.invalid_command_args' };

      await backpackSystem.addItem(playerId, itemName, quantity);
      return { status: 'success', data: { player, itemName, quantity }, templateKey: 'backpack:add_item.success' };
    }
  };

  core.registerModule('backpack', { doors, templates, handlers });
  
  core.log('info', '背包系统模块加载成功。');

  return {
    moduleName: 'backpack',
    ...backpackSystem
  };
}

backpackModule.moduleName = 'backpack';
backpackModule.dependencies = ['database', 'player', 'item'];

module.exports = backpackModule;