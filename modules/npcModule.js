/**
 * NPC 系统模块 - 处理 NPC 对话、商店进入、兑换与随机移动
 */
async function npcModule(core) {
  core.log('info', '正在加载 NPC 系统模块...');

  core.registerModule('npc', {
    doors: [
      { default_triggers: ['对话'], logical_name: 'npc:dialogue', description: '与指定NPC对话' },
      { default_triggers: ['进入商店'], logical_name: 'npc:enter_shop', description: '进入指定NPC的商店' },
      { default_triggers: ['查询NPC'], logical_name: 'npc:query', description: '查询指定NPC的信息' },
      { default_triggers: ['兑换'], logical_name: 'npc:exchange', description: '在NPC处兑换货币' }
    ],
    templates: {
      'npc:dialogue.fail_not_found': { text: '❌ [NPC名] 不在这里。', markdown: '❌ **[NPC名]** 不在这里。' },
      'npc:dialogue.success': { text: '📜 【[NPC名]】\n[NPC介绍]', markdown: '📜 【**[NPC名]**】\n[NPC介绍]' },
      'npc:enter_shop.fail_npc_not_found': { text: '❌ [NPC名] 不在这里或没有商店。', markdown: '❌ **[NPC名]** 不在这里或没有商店。' },
      'npc:enter_shop.fail_no_shop_function': { text: '❌ 该NPC没有商店功能。', markdown: '❌ 该NPC没有商店功能。' },
      'npc:query.success': { text: '📜 【[NPC名]】\n介绍：[NPC介绍]\n功能：[NPC功能列表]', markdown: '📜 【**[NPC名]**】\n介绍：[NPC介绍]\n功能：[NPC功能列表]' },
      'npc:exchange.fail_insufficient_currency': { text: '❌ 你的 [兑换目标货币] 不足。', markdown: '❌ 你的 **[兑换目标货币]** 不足。' },
      'npc:exchange.success': { text: '你成功兑换了 [兑换数量] [兑换目标货币]。', markdown: '你成功兑换了 **[兑换数量]** **[兑换目标货币]**。' },
      'npc:dialogue.fail_missing_name': { text: '请指定要对话的 NPC 名称。用法：/对话 [NPC名]', markdown: '请指定要对话的 NPC 名称。用法：/对话 [NPC名]' },
      'npc:enter_shop.fail_missing_name': { text: '请指定 NPC 名称。用法：/进入商店 [NPC名]', markdown: '请指定 NPC 名称。用法：/进入商店 [NPC名]' },
      'npc:query.fail_missing_name': { text: '请指定 NPC 名称。用法：/查询NPC [NPC名]', markdown: '请指定 NPC 名称。用法：/查询NPC [NPC名]' },
      'npc:exchange.fail_invalid_args': { text: '用法：/兑换 [货币2|货币3] [数量]', markdown: '用法：/兑换 [货币2|货币3] [数量]' },
      'npc:exchange.fail_no_npc': { text: '这里没有人可以帮你兑换货币。', markdown: '这里没有人可以帮你兑换货币。' },
      'npc:enter_shop.success': { text: '📜 【[商店名]】\n[商店介绍]\n[商品列表数据]\n[if:商店折扣]折扣: [商店折扣]% (剩余 [折扣持续时间] 分钟)[/if]', markdown: '📜 【**[商店名]**】\n[商店介绍]\n[商品列表数据]\n[if:商店折扣]折扣: [商店折扣]% (剩余 [折扣持续时间] 分钟)[/if]' }
    },
    handlers: {
      'npc:dialogue': async (request) => {
        const { playerId, args, core, services } = request;
        const npcName = args[0];
        const player = await services.player.get(playerId);

        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }

        if (!npcName) {
          return { status: 'fail_missing_npc_name', templateKey: 'npc:dialogue.fail_missing_name' };
        }

        const npc = await services.query.get('npcs', npcName);
        const currentMap = player.当前地图 || player.初始地图;

        if (!npc || npc.map_name !== currentMap) {
          return { status: 'fail_not_found', data: { NPC名: npcName }, templateKey: 'npc:dialogue.fail_not_found' };
        }

        // 检查功能
        const functions = npc.functions || [];
        let extraInfo = '';
        if (functions.includes('task')) {
          const availableQuests = [];
          const questMod = core.getModule('quest');
          
          for (const qName of (npc.quests || [])) {
            // 检查玩家是否已经接受或完成
            const isAccepted = player.quests?.some(q => q.name === qName);
            const isCompleted = player.completedQuests?.includes(qName);
            
            if (!isAccepted && !isCompleted) {
              // 检查是否满足接受条件 (可选，这里简单显示可接受的任务)
              availableQuests.push(qName);
            }
          }

          if (availableQuests.length > 0) {
            extraInfo += `\n\n📜 可接受任务：\n${availableQuests.map(q => `▫️ ${q}`).join('\n')}`;
          }
        }

        // 任务系统靠这条事件推进「与 NPC 对话」类目标（2026-09-22 补）——
        // 以前对话不产生任何事件，talk 类任务（11 条）永远推不动。
        await core.emit('npc:talked', playerId, npc.name, currentMap);

        return { 
          status: 'success',
          data: {
            NPC名: npc.name,
            NPC介绍: npc.description + extraInfo,
            npc: npc
          },
          templateKey: 'npc:dialogue.success'
        };
      },

      'npc:enter_shop': async (request) => {
        const { playerId, args, core, services } = request;
        const npcName = args[0];
        const player = await services.player.get(playerId);
        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }

        if (!npcName) {
          return { status: 'fail_missing_npc_name', templateKey: 'npc:enter_shop.fail_missing_name' };
        }

        const npc = await services.query.get('npcs', npcName);
        const currentMap = player.当前地图 || player.初始地图;

        if (!npc || npc.map_name !== currentMap) {
          return { status: 'fail_npc_not_found', data: { NPC名: npcName }, templateKey: 'npc:enter_shop.fail_npc_not_found' };
        }

        if (!npc.functions.includes('shop') || !npc.shop_name) {
          return { status: 'fail_no_shop_function', data: {}, templateKey: 'npc:enter_shop.fail_no_shop_function' };
        }

        const shopMod = core.getModule('shop');
        const shopRenderResult = await shopMod.renderShopList(npc.shop_name, playerId, services);
        return { status: 'success', data: shopRenderResult.data, templateKey: shopRenderResult.templateKey };
      },

      'npc:query': async (request) => {
        const { playerId, args, core, services } = request;
        const npcName = args[0];
        const player = await services.player.get(playerId);
        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }

        if (!npcName) {
          return { status: 'fail_missing_npc_name', templateKey: 'npc:query.fail_missing_name' };
        }

        const npc = await services.query.get('npcs', npcName);
        const currentMap = player.当前地图 || player.初始地图;

        if (!npc || npc.map_name !== currentMap) {
          return { status: 'fail_not_found', data: { NPC名: npcName }, templateKey: 'npc:dialogue.fail_not_found' };
        }

        const funcMap = {
          dialogue: '对话',
          shop: '商店',
          task: '任务',
          exchange: '兑换'
        };
        const funcList = (npc.functions || []).map(f => funcMap[f] || f).join(', ');

        return {
          status: 'success',
          data: {
            NPC名: npc.name,
            NPC介绍: npc.description,
            NPC功能列表: funcList,
            npc: npc
          },
          templateKey: 'npc:query.success'
        };
      },

      'npc:exchange': async (request) => {
        const { playerId, args, core, services } = request;
        // 用法：/兑换 [目标货币] [数量]
        const targetCurrency = args[0];
        const amount = parseInt(args[1]);
        const player = await services.player.get(playerId);
        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }

        if (!targetCurrency || isNaN(amount) || amount <= 0) {
          return { status: 'fail_invalid_args', templateKey: 'npc:exchange.fail_invalid_args' };
        }

        // 查找当前地图是否有支持兑换的 NPC
        const currentMap = player.当前地图 || player.初始地图;
        const npcs = await services.query.list('npcs');
        const npc = npcs.find(n => n.map_name === currentMap && n.functions.includes('exchange'));

        if (!npc) {
          return { status: 'fail_no_exchange_npc', templateKey: 'npc:exchange.fail_no_npc' };
        }

        const settings = npc.exchange_settings || {};
        let sourceField, targetField, rate, fee;

        // 获取目标货币别名
        const c2Alias = await services.query.getAlias('货币2');
        const c3Alias = await services.query.getAlias('货币3');

        core.log('debug', `[NPC:Exchange] targetCurrency=${targetCurrency}, c2Alias=${c2Alias}, c3Alias=${c3Alias}`);

        if (targetCurrency === '货币2' || targetCurrency === c2Alias || targetCurrency === '2' || targetCurrency === 'currency2') {
          sourceField = '货币1';
          targetField = '货币2';
          rate = settings.currency2_rate || 100;
          fee = settings.currency2_fee || 0;
        } else if (targetCurrency === '货币3' || targetCurrency === c3Alias || targetCurrency === '3' || targetCurrency === 'currency3') {
          sourceField = '货币2';
          targetField = '货币3';
          rate = settings.currency3_rate || 1000;
          fee = settings.currency3_fee || 0;
        } else {
          return { status: 'fail_unsupported_currency', content: `仅支持兑换为 ${c2Alias} 或 ${c3Alias}。` };
        }

        const totalCost = Math.ceil(amount * rate * (1 + fee));
        if ((player[sourceField] || 0) < totalCost) {
          return { status: 'fail_insufficient_currency', data: { 兑换目标货币: await services.query.getAlias(targetField) }, templateKey: 'npc:exchange.fail_insufficient_currency' };
        }

        // 执行兑换
        // 先扣源货币
  const takeResult = await services.player.takeCurrency({
    playerId, field: sourceField, amount: totalCost, source: 'npc:exchange'
  });
  if (!takeResult.success) {
    return { status: 'fail_currency', data: { message: takeResult.message }, templateKey: 'npc:exchange.fail_currency' };
  }
  // 再发放目标货币
  await services.player.giveCurrency({
    targets: [playerId], field: targetField, amount, source: 'npc:exchange'
  });

        // 货币变化事件已由 services.player.takeCurrency/giveCurrency 内部的 updateState 触发，
        // 此处不再重复触发（原代码引用了未定义的 playerChanges，会抛 ReferenceError —— 2026-09-14 修复）

        return { status: 'success', data: { 兑换目标货币: await services.query.getAlias(targetField), 兑换数量: amount }, templateKey: 'npc:exchange.success' };
      }
    }
  });

  // 定时移动逻辑
  const moveTimer = setInterval(async () => {
    const npcs = await core.services.query.list('npcs');
    for (const npc of npcs) {
      if (npc.move_probability > 0 && Math.random() < npc.move_probability) {
        await moveNpc(core, core.services, npc);
      }
    }
  }, 60000); // 每分钟尝试移动一次

  async function moveNpc(core, services, npc) {
    const currentMapName = npc.map_name;
    const currentMap = await services.query.get('maps', currentMapName);
    if (!currentMap || !currentMap.connections) return;

    // 获取所有有效的相邻地图
    const possibleDestinations = Object.values(currentMap.connections).filter(dest => dest);
    if (possibleDestinations.length === 0) return;

    const newMapName = possibleDestinations[Math.floor(Math.random() * possibleDestinations.length)];
    
    // 更新 NPC 位置
    const oldMapName = currentMapName;
    npc.map_name = newMapName;
    
    // 同步到数据库
    await core.db.saveNpc(npc.name, npc);
    
    // 同步到核心状态
    core.updateState(`npcs.${npc.name}`, npc);
    
    // 同步地图数据 (可选，需求建议以 NPC 表为准，但为了显示，我们可以更新地图状态中的 npcs 列表)
    if (core.state.world.maps) {
      if (core.state.world.maps[oldMapName]) {
        core.state.world.maps[oldMapName].npcs = (core.state.world.maps[oldMapName].npcs || []).filter(n => n !== npc.name);
      }
      if (core.state.world.maps[newMapName]) {
        if (!core.state.world.maps[newMapName].npcs) core.state.world.maps[newMapName].npcs = [];
        if (!core.state.world.maps[newMapName].npcs.includes(npc.name)) {
          core.state.world.maps[newMapName].npcs.push(npc.name);
        }
      }
    }

    core.log('info', `NPC ${npc.name} 从 ${oldMapName} 移动到了 ${newMapName}`);
    
    // 触发事件
    await core.emit('npc:moved', npc.name, oldMapName, newMapName);
  }

  // 清理定时器
  const unload = () => {
    clearInterval(moveTimer);
  };

  core.log('info', 'NPC 系统模块加载成功。');

  core.registerDataSource('NPC', {
    description: 'NPC 定义表',
    fields: ['名称','介绍','位置','功能'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM npcs WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','介绍':'description','位置':'map_name','功能':'functions' };
      return row[map[字段]];
    }
  });

  return {
    moduleName: 'npc',
    moveNpc: moveNpc,
    unload: unload
  };
}

npcModule.moduleName = 'npc';
npcModule.dependencies = ['database', 'player', 'map'];

module.exports = npcModule;
