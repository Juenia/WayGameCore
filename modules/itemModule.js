/**
 * 物品系统模块 - 提供物品定义查询、分类管理及效果执行引擎
 */
async function itemModule(core) {
  core.log('info', '正在加载物品系统模块...');

  // 1. 效果注册表
  const effectHandlers = new Map();

  // 2. 初始化物品定义表
  const { worldSeed } = require('./world/load.js');

  const defaultItems = {
    // --- 药水 ---
    '初级药水': { 
      name: '初级药水', category: '药水', type: '消耗品', description: '回复少量生命值',
      effects: [{ type: 'heal_fixed', target: '生命', value: 50 }] 
    },
    '中级药水': { 
      name: '中级药水', category: '药水', type: '消耗品', description: '回复中量生命值',
      effects: [{ type: 'heal_fixed', target: '生命', value: 200 }] 
    },
    '大型药水': { 
      name: '大型药水', category: '药水', type: '消耗品', description: '回复一半生命值',
      effects: [{ type: 'heal_percent', target: '生命', percent: 50 }] 
    },
    '魔法药水': { 
      name: '魔法药水', category: '药水', type: '消耗品', description: '回复少量魔法值',
      effects: [{ type: 'heal_fixed', target: '魔法', value: 30 }] 
    },
    '毒药': { 
      name: '毒药', category: '药水', type: '消耗品', description: '使用后降低攻击',
      effects: [{ type: 'debuff_attack', value: 10, duration: 0 }] 
    },
    '自杀药水': { 
      name: '自杀药水', category: '药水', type: '消耗品', description: '使用后生命归零',
      effects: [{ type: 'suicide' }] 
    },

    // --- 材料 ---
    '木材': { name: '木材', category: '材料', type: '材料', description: '基础材料' },
    '铁矿石': { name: '铁矿石', category: '材料', type: '材料', description: '基础矿石' },
    '草药': { name: '草药', category: '材料', type: '材料', description: '可以用来炼药的草药' },
    '解封石': { name: '解封石', category: '材料', type: '材料', description: '用于解除装备封印的特殊石头' },

    // --- 礼包 ---
    '新手礼包': { 
      name: '新手礼包', category: '礼包', type: '礼包', description: '新手福利',
      rewards: [
        { type: 'currency', currencyType: 1, amount: 100 },
        { type: 'item', itemName: '初级药水', quantity: 2 },
        { type: 'item', itemName: '木材', quantity: 3 },
        { type: 'equipment', equipmentName: '铁剑', quantity: 1 }
      ]
    },
    '测试礼包': {
      name: '测试礼包', category: '礼包', type: '礼包', description: '用于测试的礼包',
      rewards: [
        { type: 'item', name: '升级丹', quantity: 15 }
      ]
    },

    // --- 转职 ---
    '转职凭证·战士': { 
      name: '转职凭证·战士', category: '转职', type: '转职', description: '转职为战士',
      classChange: { mode: 'fixed', targetClass: '战士' }
    },
    '转职凭证·随机': { 
      name: '转职凭证·随机', category: '转职', type: '转职', description: '随机转职',
      classChange: { mode: 'random', choices: ['战士', '法师', '弓箭手'] }
    },

    // --- 消耗品 ---
    '升级丹': { 
      name: '升级丹', category: '消耗品', type: '消耗品', description: '使用后提升1级',
      effects: [{ type: 'level_up', levels: 1 }]
    },
    '1000经验丹': { 
      name: '1000经验丹', category: '消耗品', type: '消耗品', description: '获得1000经验',
      effects: [{ type: 'exp_fixed', value: 1000 }]
    },
    '50%经验丹': { 
      name: '50%经验丹', category: '消耗品', type: '消耗品', description: '获得当前升级所需50%经验',
      effects: [{ type: 'exp_percent', percent: 50 }]
    },
    '传送符': { 
      name: '传送符', category: '消耗品', type: '消耗品', description: '传送到城镇',
      effects: [{ type: 'teleport', targetMap: '城镇' }]
    },
    '世界喇叭': { 
      name: '世界喇叭', category: '消耗品', type: '消耗品', description: '发送全服广播',
      effects: [{ type: 'world_broadcast', message: '玩家 [昵称] 使用了世界喇叭！' }]
    }
  };

  // 存储在 core.state.items 中，确保包含默认物品
  // ── 世界种子合并（2026-09-19）──────────────────────────────────────────────
  // modules/world/items.json 是从当前正式世界（data/game.db）导出的内容种子，是唯一真源；
  // 上面的内置小世界只在种子文件缺失/为空时兜底。于是「空库新装」种出来的就是主人现在的
  // 世界，已有库一条都不会动（下面的写入本来只在物品表为空时执行）。
  const worldItems = worldSeed('items', Object.values(defaultItems));
  const seedItems = Object.fromEntries(worldItems.map((d) => [d.name, d]));
  const dbItems = await core.db.getAllItems();
  if (dbItems.length === 0) {
    core.log('info', `数据库物品表为空，正在写入世界种子物品数据（${worldItems.length} 条）...`);
    for (const [name, def] of Object.entries(seedItems)) {
      await core.db.saveItem(name, def);
    }
  }

  // 同步内存状态
  const allItems = await core.db.getAllItems();
  const itemObj = {};
  allItems.forEach(i => itemObj[i.name] = i);
  core.updateState('items', { ...itemObj, ...core.config.items });
  core.log('info', `从数据库加载了 ${allItems.length} 个物品定义。`);

  // 3. 效果处理器实现
  const effectHandlersMap = { // Renamed to avoid conflict with `handlers` for registerModule
    // 固定值恢复
    heal_fixed: async (playerId, effect, quantity, player) => {
      const target = effect.target;
      const totalValue = effect.value * quantity;
      const maxField = target === '生命' ? '生命上限' : (target === '魔法' ? '魔法上限' : `max${target}`);
      const maxValue = player[maxField] !== undefined ? player[maxField] : (player[`max${target}`] !== undefined ? player[`max${target}`] : player[target]);
      
      const oldValue = player[target] || 0;
      player[target] = Math.min(maxValue, oldValue + totalValue);
      
      return { success: true, message: `${target}恢复了 ${player[target] - oldValue} 点` };
    },
    // 百分比恢复
    heal_percent: async (playerId, effect, quantity, player) => {
      const target = effect.target;
      const maxField = target === '生命' ? '生命上限' : (target === '魔法' ? '魔法上限' : `max${target}`);
      const maxValue = player[maxField] !== undefined ? player[maxField] : (player[`max${target}`] !== undefined ? player[`max${target}`] : player[target]);
      
      const healPerOne = Math.floor(maxValue * (effect.percent / 100));
      const totalHeal = healPerOne * quantity;
      
      const oldValue = player[target] || 0;
      player[target] = Math.min(maxValue, oldValue + totalHeal);
      
      return { success: true, message: `${target}恢复了 ${player[target] - oldValue} 点` };
    },
    // 减属性
    debuff_attack: async (playerId, effect, quantity, player) => {
      const totalLoss = effect.value * quantity;
      player.攻击 = Math.max(0, (player.攻击 || 0) - totalLoss);
      return { success: true, message: `攻击降低了 ${totalLoss} 点` };
    },
    debuff_defense: async (playerId, effect, quantity, player) => {
      const totalLoss = effect.value * quantity;
      player.防御 = Math.max(0, (player.防御 || 0) - totalLoss);
      return { success: true, message: `防御降低了 ${totalLoss} 点` };
    },
    // 自杀
    suicide: async (playerId, effect, quantity, player) => {
      player.生命 = 0;
      await core.emit('player:died', playerId);
      return { success: true, message: '你自杀了...' };
    },
    // 升级
    level_up: async (playerId, effect, quantity, player) => {
      const levels = effect.levels * quantity;
      const oldLevel = player.等级 || 1;
      player.等级 = oldLevel + levels;
      
      // 每级提升属性
      player.生命上限 = (player.生命上限 || 100) + levels * 20;
      player.生命 = player.生命上限;
      player.攻击 = (player.攻击 || 10) + levels * 2;
      
      await core.emit('player:level_up', playerId, oldLevel, player.等级);
      return { success: true, message: `等级提升了 ${levels} 级！当前等级: ${player.等级}` };
    },
    // 固定经验
    exp_fixed: async (playerId, effect, quantity, player) => {
      let exp = effect.value * quantity;
      const expBonus = player._expMultiplierBonus || 0;
      if (expBonus > 0) {
        exp += Math.floor(exp * expBonus);
      }
      player.经验 = (player.经验 || 0) + exp;
      return { success: true, message: `获得了 ${exp} 点经验${expBonus > 0 ? ` (+${Math.round(expBonus * 100)}%)` : ''}` };
    },
    // 百分比经验
    exp_percent: async (playerId, effect, quantity, player) => {
      const level = player.等级 || 1;
      const nextLevelExp = level * 100; // 简化升级曲线
      let expPerOne = Math.floor(nextLevelExp * (effect.percent / 100));
      
      const expBonus = player._expMultiplierBonus || 0;
      if (expBonus > 0) {
        expPerOne += Math.floor(expPerOne * expBonus);
      }
      
      const totalExp = expPerOne * quantity;
      player.经验 = (player.经验 || 0) + totalExp;
      return { success: true, message: `获得了 ${totalExp} 点经验${expBonus > 0 ? ` (+${Math.round(expBonus * 100)}%)` : ''}` };
    },
    // 传送
    teleport: async (playerId, effect, quantity, player) => {
      const oldMap = player.当前地图;
      player.当前地图 = effect.targetMap;
      await core.emit('player:moved', playerId, oldMap, effect.targetMap);
      return { success: true, message: `传送到了 ${effect.targetMap}` };
    },
    // 世界广播
    world_broadcast: async (playerId, effect, quantity, player) => {
      const message = await core.renderTemplate(effect.message, player, { escape: false }, playerId);
      core.log('info', `[WORLD_BROADCAST] ${message}`);
      return { success: true, message: `广播内容: ${message}` };
    },
    // BUFF/DEBUFF 通用
    buff: async (playerId, effect, quantity, player) => {
      const target = effect.target;
      const value = effect.value * quantity;
      player[target] = (player[target] || 0) + value;
      return { success: true, message: `${target}提升了 ${value} 点 (持续时间逻辑暂未实现)` };
    },
    debuff: async (playerId, effect, quantity, player) => {
      const target = effect.target;
      const value = effect.value * quantity;
      player[target] = Math.max(0, (player[target] || 0) - value);
      return { success: true, message: `${target}降低了 ${value} 点 (持续时间逻辑暂未实现)` };
    },
    // 额外开出一件别的物品（2026-09-20）：给「残卷」这类「读着读着夹带点东西」的消耗品用。
    // 与「礼包」的区别：礼包要 category === '礼包' 才会走 rewards 分支（见上面 300 行），
    // 这个效果类型任何物品都能带，配 {"type":"give_item","name":"古币","count":2}。
    // 物品表里没有这个名字时**照实报错**，不硬塞一件不存在的东西进背包。
    give_item: async (playerId, effect, quantity, player) => {
      const name = String(effect.name || effect.itemName || '').trim();
      if (!name) return { success: false, message: '这个效果没写要开出什么物品（缺 name）' };
      const times = Math.max(1, Math.floor(Number(quantity) || 1));
      const each = Math.max(1, Math.floor(Number(effect.count || effect.amount || 1)));
      const total = each * times;
      const def = await itemSystem.getDefinition(name);
      if (!def) return { success: false, message: '物品表里没有「' + name + '」，没有硬塞进你背包' };
      const backpack = core.getModule('backpack');
      if (!backpack || !backpack.addItem) return { success: false, message: '背包模块没挂上，开不出来' };
      await backpack.addItem(playerId, name, total);
      return { success: true, message: '额外得到 ' + name + ' ×' + total };
    },
    // 解除负面状态（2026-09-20）：buff 挂在玩家对象的「buff列表」上（{name,multiplier,expires_at}），
    // 战斗开始时由 combatModule 读 player_buffs 应用（combatModule.js:180）。
    // effect.target 留空 = 清掉所有负面；填了 = 只清名字里含这个词的（例如「中毒」）。
    // 注意：清完是改玩家对象，applyEffects 收尾会连同其它变化一起写回（player.modify {set}），
    // 所以 player_buffs 表下一拍就同步了，不用在这里直接写库。
    cure_buff: async (playerId, effect, quantity, player) => {
      const list = Array.isArray(player.buff列表) ? player.buff列表 : [];
      const want = String(effect.target || '').trim();
      const BAD = ['毒', '诅咒', '虚弱', '减速', '燃烧', '流血', '眩晕', '麻痹', '封印', '降低'];
      const isBad = (n) => BAD.some((k) => n.indexOf(k) >= 0);
      const keep = [], removed = [];
      for (const b of list) {
        const nm = String((b && b.name) || '');
        const hit = want ? (nm.indexOf(want) >= 0) : isBad(nm);
        if (hit) removed.push(nm); else keep.push(b);
      }
      if (!removed.length) return { success: true, message: '你现在没有' + (want || '负面') + '状态' };
      player.buff列表 = keep;
      return { success: true, message: '解除了：' + removed.join('、') };
    }
  };

  // 注册内置效果
  Object.entries(effectHandlersMap).forEach(([type, handler]) => { // Changed to effectHandlersMap
    effectHandlers.set(type, handler);
  });

  // 4. 提供接口
  const itemSystem = {
    /**
     * 注册新的效果类型
     */
    registerEffectType: (type, handler) => {
      effectHandlers.set(type, handler);
      core.log('info', `物品系统已注册新效果类型: ${type}`);
    },

    /**
     * 获取物品定义
     */
    getDefinition: async (name) => {
      // 1. 先从内存查
      const items = core.state.items || {};
      if (items[name]) return items[name];
      // 2. 再从数据库查
      if (core.db?.getItem) {
        const dbItem = await core.db.getItem(name);
        if (dbItem) return dbItem;
      }
      return null;
    },

    /**
     * 获取支持的分类列表
     */
    getCategories: () => {
      return ['药水', '材料', '礼包', '转职', '消耗品'];
    },

    /**
     * 向背包系统注册单个分类
     */
    registerItemCategory: (category) => {
      const backpack = core.getModule('backpack');
      if (backpack && backpack.registerCategory) {
        backpack.registerCategory(category, 'item');
      }
    },

    /**
     * 向背包系统注册所有默认分类
     */
    registerItemCategories: () => {
      itemSystem.getCategories().forEach(cat => {
        itemSystem.registerItemCategory(cat);
      });
    },

    /**
     * 执行物品效果
     */
    applyEffects: async (playerId, itemName, quantity = 1, services) => {
      const def = await itemSystem.getDefinition(itemName);
      if (!def) return { success: false, message: '未找到物品定义' };

      const player = await services.player.get(playerId);
      if (!player) return { success: false, message: '未找到玩家数据' };
      const beforeSnapshot = JSON.parse(JSON.stringify(player));

      const results = [];
      let overallSuccess = true;

      // --- 处理礼包类型 ---
      if (def.category === '礼包') {
        let rewards = [];
        try {
          if (typeof def.rewards === 'string' && def.rewards.trim()) {
            rewards = JSON.parse(def.rewards);
          } else if (Array.isArray(def.rewards)) {
            rewards = def.rewards;
          }
        } catch (e) {
          core.log('error', `解析礼包奖励失败: ${e.message}, 原始数据: ${def.rewards}`);
        }

        core.log('debug', `正在开启礼包: ${itemName}, 奖励数量: ${rewards.length}`);

        if (rewards.length > 0) {
          const rewardsReceived = [];
          const backpack = core.getModule('backpack');

          for (let i = 0; i < quantity; i++) {
            for (const reward of rewards) {
              // 增强的兼容性处理：处理多种可能的奖励字段名
              let type = reward.type;
              let rItemName = reward.itemName || reward.name || reward.item || reward.equipmentName || reward.equipment;
              let amount = reward.amount || reward.quantity || reward.count || (typeof reward.value === 'number' ? reward.value : 1);

              // 如果没有显式 type，尝试根据字段推断
              if (!type) {
                if (reward.currencyType || reward.currency) type = 'currency';
                else if (reward.equipmentName || reward.equipment) type = 'equipment';
                else if (rItemName) type = 'item';
              }

              // 处理 value 字段作为备用（有些旧数据可能直接放 value）
              if (!rItemName && type !== 'currency' && reward.value && typeof reward.value === 'string') {
                rItemName = reward.value;
              }

              core.log('debug', `解析奖励: type=${type}, name=${rItemName}, amount=${amount}`);

              if (type === 'currency') {
                const currencyFields = { 1: '货币1', 2: '货币2', 3: '货币3' };
                const cType = reward.currencyType || reward.type_value || reward.value || 1;
                const field = currencyFields[cType];
                if (field) {
                  await services.player.giveCurrency({ targets: [playerId], field, amount, source: 'item:use' });
                  rewardsReceived.push(`${core.getAlias(field)} x${amount}`);
                }
              } else if ((type === 'item' || type === 'equipment' || !type) && rItemName) {
                if (backpack?.addItem) {
                  await backpack.addItem(playerId, rItemName, amount);
                  rewardsReceived.push(`${rItemName} x${amount}`);
                }
              }
            }
          }
          await core.emit('item:gift_opened', playerId, itemName, rewardsReceived);
          results.push({ type: 'gift', success: true, message: `开启礼包获得了:\n${rewardsReceived.map(r => '• ' + r).join('\n')}` });
        } else {
          results.push({ type: 'gift', success: true, message: '这个礼包似乎是空的。' });
        }
      }

      // --- 处理转职类型 ---
      if (def.category === '转职' && (def.classChange || def.转职效果职业设置)) {
        const cc = def.classChange || { mode: 'fixed', targetClass: def.转职效果职业设置 };
        const oldClass = player.职业途径;
        let newClass = oldClass;

        if (cc.mode === 'fixed') {
          newClass = cc.targetClass;
        } else if (cc.mode === 'random') {
          const choices = cc.choices || def.转职效果多职业设置 || [];
          if (choices.length > 0) {
            newClass = choices[Math.floor(Math.random() * choices.length)];
          }
        }

        if (newClass !== oldClass) {
          player.职业途径 = newClass;
          // 同步职业序列为该职业的第一序列（如 剑客→剑客、法师→学徒）
          try {
            const profRow = await core.db.get('SELECT sequences FROM professions WHERE name = ?', [newClass]);
            if (profRow) {
              const seqs = JSON.parse(profRow.sequences || '[]');
              if (Array.isArray(seqs) && seqs.length > 0 && seqs[0].name) player.职业序列 = seqs[0].name;
            }
          } catch (e) {
            core.log('warn', '[item:classChange] 读取职业首序列失败: ' + e.message);
          }
          await core.emit('player:class_changed', playerId, oldClass, newClass);
          results.push({ type: 'class_change', success: true, message: `职业已变更为: ${newClass}` });
        } else {
          results.push({ type: 'class_change', success: true, message: `你已经是 ${newClass} 了` });
        }
      }

      // --- 处理通用效果 (药水/消耗品) ---
      if (def.effects && def.effects.length > 0) {
        for (const effect of def.effects) {
          const handler = effectHandlers.get(effect.type);
          if (handler) {
            const res = await handler(playerId, effect, quantity, player);
            results.push({ ...res, type: effect.type });
            if (!res.success) overallSuccess = false;
          } else {
            core.log('warn', `未知的效果类型: ${effect.type}`);
            results.push({ type: effect.type, success: false, message: `未知效果: ${effect.type}` });
            overallSuccess = false;
          }
        }
      }

      if (overallSuccess) {
        const changes = {};
        for (const key of Object.keys(player)) {
          if (JSON.stringify(player[key]) !== JSON.stringify(beforeSnapshot[key])) {
            changes[key] = { set: player[key] };
          }
        }
        if (Object.keys(changes).length > 0) {
          await services.player.modify({ playerId, changes, source: 'item:effect_applied' });
        }
        await core.emit('item:effect_applied', playerId, itemName, quantity, results);
        // 2026-09-18：战斗中使用物品 → 让怪物反击。combatModule 一直在监听 combat:item_used，
        // 但全仓没有任何地方 emit 过它 —— 那条反击链是死的（事件契约测试 K1 抓到的）。
        // 只在「该玩家确实在战斗中」时发，非战斗用物品不受影响；发事件失败不影响道具效果。
        try {
          const _cb = core.state && core.state.combat && core.state.combat[playerId];
          if (_cb && _cb.status === 'active') await core.emit('combat:item_used', playerId, itemName, quantity, results);
        } catch (e) { /* 事件失败不影响用物品 */ }
      }

      return {
        success: overallSuccess,
        results,
        message: results.map(r => r.message).filter(Boolean).join('\n')
      };
    }
  };

  const doors = [
    { logical_name: 'item:use', default_triggers: ['使用'], aliases: ['use'], description: '使用背包中的物品' },
    { logical_name: 'item:view', default_triggers: ['查看物品'], aliases: ['view', '查询物品'], description: '查看物品的详细信息' }
  ];

  const templates = {
    'item:use.success': { text: '💊 你使用了 {物品名}。\n✨ 效果：{结果}', markdown: '💊 你使用了 {物品名}。\n✨ 效果：{结果}' },
    'item:use.failed': { text: '使用失败。', markdown: '使用失败。' },
    'item:view.success': { text: '【{物品名}】\n分类：{物品分类}\n介绍：{物品介绍}', markdown: '【**{物品名}**】\n分类：{物品分类}\n介绍：{物品介绍}' },
    'item:view.not_found': { text: '物品 {name} 不存在。', markdown: '物品 **{name}** 不存在。' }
  };

  const handlers = {
    'item:use': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const itemName = args[0];
      const quantity = parseInt(args[1] || '1');

      if (!itemName) return '请指定要使用的物品名。';
      if (isNaN(quantity) || quantity <= 0) return '使用数量 must be a positive integer.';

      if (!player.背包 || !player.背包[itemName] || player.背包[itemName] < quantity) {
        return { status: 'fail_not_enough', data: { itemName, quantity }, templateKey: 'item:use.not_enough' };
      }

      const result = await itemSystem.applyEffects(playerId, itemName, quantity, services);
      
      if (result.success) {
        const backpack = core.getModule('backpack');
        await backpack.removeItem(playerId, itemName, quantity);
        
        const data = { 
          物品名: itemName, 
          itemName: itemName, 
          结果: result.message,
          message: result.message,
          name: itemName,
          result: result.message
        };

        return { status: 'success', data: data, templateKey: 'item:use.success' };
      }

      return { status: 'failed', data: { message: result.message }, templateKey: 'item:use.failed' };
    },

    'item:view': async (request) => {
      const { playerId, args, core, services } = request;
      const name = args[0];
      if (!name) return { status: 'fail_no_target', data: {}, templateKey: 'item:view.no_target' };

      // 1. 尝试查找物品
      const itemDef = await itemSystem.getDefinition(name);
      if (itemDef) {
        return { 
          status: 'view_item', 
          data: { 
            物品名: itemDef.name, 
            物品分类: itemDef.category, 
            物品介绍: itemDef.description || '无介绍',
            item: itemDef
          }, 
          templateKey: 'item:view.success' 
        };
      }


      return { status: 'not_found', data: { name }, templateKey: 'item:view.not_found' };
    }
  };

  core.registerModule('item', { doors, templates, handlers });

  // 挂载到核心实例
  core.item = itemSystem;

  core.log('info', '物品系统模块加载完成。');

  core.registerDataSource('物品', {
    description: '物品定义表',
    fields: ['名称','分类','类型','描述','攻击','防御','生命','魔法'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM items WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','分类':'category','类型':'type','描述':'description' };
      if (map[字段]) return row[map[字段]];
      try { const eff = JSON.parse(row.effects || '{}'); return eff[字段]; } catch { return undefined; }
    }
  });

  return {
    moduleName: 'item',
    ...itemSystem
  };
}

itemModule.moduleName = 'item';
itemModule.dependencies = [];

module.exports = itemModule;