/**
 * 玩家系统模块 - 处理玩家注册与基础属性管理
 */
async function playerModule(core) {
  core.log('info', '正在加载玩家系统模块...');

  // 1. 检查数据库模块是否就绪
  if (!core.db) {
    throw new Error('玩家模块加载失败：数据库模块未就绪。请确保 database 模块已优先加载。');
  }

  // 2. 获取默认配置
  const settings = core.state.settings || {};
  const defaults = {
    生命: settings.initial_attributes?.生命 || 100,
    生命上限: settings.initial_attributes?.生命上限 || 100,
    魔法: settings.initial_attributes?.魔法 || 50,
    魔法上限: settings.initial_attributes?.魔法上限 || 50,
    等级: 1,
    经验: 0,
    攻击: settings.initial_attributes?.攻击 || 10,
    防御: settings.initial_attributes?.防御 || 5,
    暴击率: settings.initial_attributes?.暴击率 || 5,
    暴击伤害: settings.initial_attributes?.暴击伤害 || 150,
    闪避率: settings.initial_attributes?.闪避率 || 5,
    货币1: settings.initial_currency1 ?? 0,
    货币2: settings.initial_currency2 ?? 0,
    货币3: settings.initial_currency3 ?? 0,
    特殊货币: settings.initial_special_currency ?? 0,
    初始地图: settings.initial_map || '新手村',
    当前地图: settings.initial_map || '新手村',
    职业途径: (settings.initial_class_path && String(settings.initial_class_path).replace(/^"|"$/g, '')) || '普通人',
    职业序列: '',
    背包: {},
    装备栏: {
      weapon: null,
      head: null,
      body: null,
      accessory: null
    },
    注册获得物品: settings.initial_items || [],
    ...core.config.playerDefaults
  };

  // 3. 注册指令逻辑处理器
  core.log('info', '玩家系统模块加载成功。已注册逻辑处理器 player:register, player:role。');

  const doors = [
    { logical_name: 'player:register', default_triggers: ['注册'], aliases: [], description: '注册新玩家角色' },
    { logical_name: 'player:info', default_triggers: ['我的信息'], aliases: ['info', '属性'], description: '查看玩家当前角色属性' },
    { logical_name: 'player:role', default_triggers: ['角色'], aliases: ['role'], description: '查看玩家角色详情' }
  ];

  const templates = {
    'player:register.invalid_args': {
      text: '注册失败：请输入昵称和性别。格式：注册 [昵称] [性别]',
      markdown: '注册失败：请输入昵称和性别。格式：注册 [昵称] [性别]'
    },
    'player:register.invalid_name': {
      text: '注册失败：昵称需 2-12 个字符，仅允许中文、字母、数字、下划线。',
      markdown: '注册失败：昵称需 2-12 个字符，仅允许中文、字母、数字、下划线。'
    },
    'player:register.invalid_gender': {
      text: '注册失败：性别仅允许 男 或 女。',
      markdown: '注册失败：性别仅允许 男 或 女。'
    },
    'player:register.data_corrupted': {
      text: '注册失败：您的玩家数据已损坏，请联系管理员。',
      markdown: '注册失败：您的玩家数据已损坏，请联系管理员。'
    },
    'player:register.duplicate': {
      text: '您已注册，无法重复注册。',
      markdown: '您已注册，无法重复注册。'},
    'player:register.success': {
      text: '注册成功！\n昵称：[玩家昵称]\n性别：[玩家性别]\n职业：[玩家职业途径] ([玩家职业序列])\n生命：[玩家生命] | 魔法：[玩家魔法]\n攻击：[玩家攻击] | 防御：[玩家防御]\n金币：[玩家金币]',
      markdown: '注册成功！\n昵称：[玩家昵称]\n性别：[玩家性别]\n职业：[玩家职业途径] ([玩家职业序列])\n生命：[玩家生命] | 魔法：[玩家魔法]\n攻击：[玩家攻击] | 防御：[玩家防御]\n金币：[玩家金币]'
    },
    'player:info.view': {
      text: `--- 角色属性 ---\n昵称：[玩家昵称]\n性别：[玩家性别]\n职业：[玩家职业途径] ([玩家职业序列])\n等级：[玩家等级] (经验: [玩家经验])\n生命：[玩家生命] / {生命上限}\n魔法：[玩家魔法] / {魔法上限}\n攻击：[玩家攻击] | 防御：[玩家防御]\n暴击：[玩家暴击率]% (爆伤: [玩家爆伤]%)\n闪避：[玩家闪避率]%\n位置：[玩家位置]\n--- 资产 ---\n货币1：[玩家货币1] | 货币2：[玩家货币2] | 货币3：[玩家货币3]\n特殊货币：[玩家特殊货币]`,
      markdown: `--- 角色属性 ---\n昵称：[玩家昵称]\n性别：[玩家性别]\n职业：[玩家职业途径] ([玩家职业序列])\n等级：[玩家等级] (经验: [玩家经验])\n生命：[玩家生命] / {生命上限}\n魔法：[玩家魔法] / {魔法上限}\n攻击：[玩家攻击] | 防御：[玩家防御]\n暴击：[玩家暴击率]% (爆伤: [玩家暴击率]%)\n闪避：[玩家闪避率]%\n位置：[玩家位置]\n--- 资产 ---\n货币1：[玩家货币1] | 货币2：[玩家货币2] | 货币3：[玩家货币3]\n特殊货币：[玩家特殊货币]`
    }
  };

  const handlers = {
    'player:register': async (request) => {
      const { playerId, args, core, services } = request;
      try {
        core.log('debug', `[player:register] 收到注册请求，playerId: ${playerId}, args: ${JSON.stringify(args)}`);

        const nickname = args[0];
        const gender = (args[1] || '').trim();

        // a. 检查参数
        if (!nickname || !gender) {
          core.log('debug', `[player:register] 参数不足，nickname: ${nickname}, gender: ${gender}`);
          return { status: 'fail_invalid_args', data: {}, templateKey: 'player:register.invalid_args' };
        }

        // b. 校验昵称长度 (从基础设置读取，默认 2-12)
        const minLen = settings.nickname_min_length || 2;
        const maxLen = settings.nickname_max_length || 12;
        if (nickname.length < minLen || nickname.length > maxLen) {
          core.log('debug', `[player:register] 昵称长度不合法，nickname: ${nickname}, min: ${minLen}, max: ${maxLen}`);
          return { status: 'fail_invalid_name', data: { minLen, maxLen }, templateKey: 'player:register.invalid_name' };
        }

        // b2. 校验昵称字符（仅中文、字母、数字、下划线）
        if (!/^[\u4e00-\u9fa5A-Za-z0-9_]+$/.test(nickname)) {
          core.log('debug', `[player:register] 昵称含非法字符：${nickname}`);
          return { status: 'fail_invalid_name', data: { minLen, maxLen }, templateKey: 'player:register.invalid_name' };
        }

        // c. 校验性别
        if (gender !== '男' && gender !== '女') {
          core.log('debug', `[player:register] 性别不合法，gender: ${gender}`);
          return { status: 'fail_invalid_gender', data: {}, templateKey: 'player:register.invalid_gender' };
        }

        // d. 检查是否已注册
        core.log('debug', `[player:register] 检查玩家 ${playerId} 是否已注册...`);
        const existingPlayer = await services.player.get(playerId);
        if (existingPlayer) {
          // Note: services.player.get() should return null if player doesn't exist, not an object with parseError
          // The parseError logic needs to be handled by the player service if data is corrupted
          if (existingPlayer.昵称) { // Simple check for valid player data
            core.log('debug', `[player:register] 玩家 ${playerId} 已注册。`);
            return { status: 'fail_duplicate', data: {}, templateKey: 'player:register.duplicate' };
          } else {
            // If existingPlayer is not null but invalid (e.g., empty object due to parse error in service)
            core.log('warn', `玩家 ${playerId} 数据损坏，无法注册。`);
            return { status: 'fail_data_corrupted', data: {}, templateKey: 'player:register.data_corrupted' };
          }
        }

        // e. 生成初始数据对象
        core.log('debug', `[player:register] settings.initial_map: ${settings.initial_map}`);
        core.log('debug', `[player:register] defaults for map: 初始地图=${defaults.初始地图}, 当前地图=${defaults.当前地图}`);
        // 实时读 settings（模块加载时可能为空）
        const liveSettings = core.state.settings || settings;
        const liveClassPath = (liveSettings.initial_class_path && String(liveSettings.initial_class_path).replace(/^"|"$/g, '')) || '普通人';
        let liveSeq = '凡人';
        try {
          const profRow = await core.db.get('SELECT sequences FROM professions WHERE name = ?', [liveClassPath]);
          if (profRow) {
            const seqs = JSON.parse(profRow.sequences || '[]');
            if (Array.isArray(seqs) && seqs.length > 0 && seqs[0].name) liveSeq = seqs[0].name;
          }
        } catch (e) {
          core.log('warn', '[player:register] 读取职业首序列失败: ' + e.message);
        }

        const playerData = {
          id: playerId, // 新增 id 字段
          昵称: nickname,
          性别: gender,
          QQ号: playerId,
          ...defaults,
          职业途径: liveClassPath,
          职业序列: liveSeq,
          注册时间: new Date().toISOString()
        };
        core.log('debug', `[player:register] 生成玩家初始数据: ${JSON.stringify(playerData)}`);
        core.log('debug', `[player:register] playerData.初始地图: ${playerData.初始地图}, playerData.当前地图: ${playerData.当前地图}`);

        // f. 保存到数据库并同步到核心状态
        core.log('debug', `[player:register] 准备保存玩家 ${playerId} 到数据库...`);
        await core.db.savePlayer(playerData); // 直接保存新玩家数据
        core.updateState(`players.${playerId}`, playerData); // 更新核心内存状态
        core.log('debug', `[player:register] 玩家 ${playerId} 保存成功，同步到核心状态。`);

        // g. 触发玩家创建事件
        core.log('debug', `[player:register] 触发 player:created 事件...`);
        // g2. 发放初始物品（新手礼包等）
        const initItems = (liveSettings && liveSettings.initial_items) || settings.initial_items || [];
        if (Array.isArray(initItems) && initItems.length > 0) {
          try {
            for (const it of initItems) {
              const name = typeof it === 'string' ? it : (it.name || it.itemName);
              const qty = typeof it === 'string' ? 1 : (it.quantity || it.count || 1);
              if (name) {
                await core.services.player.giveItems({ targets: [playerId], items: [{ name, count: qty }], source: 'player:register' });
              }
            }
            core.log('info', '[player:register] 已发放初始物品: ' + JSON.stringify(initItems));
          } catch (e) {
            core.log('warn', '[player:register] 发放初始物品失败: ' + e.message);
          }
        }

        setImmediate(() => {
      core.emit('player:created', playerId, playerData);
    });

        core.log('info', `玩家注册成功: ${nickname} (QQ: ${playerId})`);

        // h. 渲染成功提示
        return { status: 'success', data: playerData, templateKey: 'player:register.success' };
      } catch (error) {
        return { status: 'error', data: { error: error.message }, templateKey: 'system.error' };
      }
    },
    'player:info': async (request) => {
      const { playerId, core, services } = request;
      const basePlayer = await services.player.get(playerId);
      if (!basePlayer) {
        // Player not found, perhaps not registered or data corrupted
        return { status: 'fail_not_found', data: {}, templateKey: 'system.player_not_found' };
      }

      // 获取被动技能加成
      const skillMod = core.getModule('skill');
      const passiveBonuses = skillMod ? await skillMod.getPassiveBonuses(playerId, services) : {};
      
      // 合并属性用于展示
      const player = { ...basePlayer };
      for (const [attr, val] of Object.entries(passiveBonuses)) {
        player[attr] = (player[attr] || 0) + val;
      }

      return { status: 'view', data: player, templateKey: 'player:info.view' };
    }
  ,
    'player:role': async (request) => {
      const { playerId, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_not_found', data: {}, templateKey: 'system.player_not_found' };
      return { status: 'view', data: player, templateKey: 'player:role.view' };
    }
  };
  core.registerModule('player', { doors, templates, handlers });

  const playerExports = {
    // 获取玩家信息
    getPlayerInfo: async (playerId) => await core._playerService.get(playerId),

    // 添加/减少货币
    addCurrency: async (playerId, currencyId, amount) => {
      const player = await core._playerService.get(playerId);
      if (!player) return false;
      const field = `货币${currencyId}`;
      const oldValue = player[field] || 0;
      const newValue = oldValue + amount;
      if (newValue < 0) return false; // 不允许扣成负数

      await core._playerService.modify({ playerId, changes: { [field]: newValue }, source: `player:addCurrency` });
      
      // 触发货币变化事件
      setImmediate(() => {
        core.emit('player:currency_changed', playerId, field, newValue);
      });
      return true;
    },

    // 添加/减少特殊货币
    addSpecialCurrency: async (playerId, amount) => {
      const player = await core._playerService.get(playerId);
      if (!player) return false;
      const oldValue = player.特殊货币 || 0;
      const newValue = oldValue + amount;
      if (newValue < 0) return false; // 不允许扣成负数

      await core._playerService.modify({ playerId, changes: { '特殊货币': newValue }, source: `player:addSpecialCurrency` });
      
      // 触发特殊货币变化事件
      setImmediate(() => {
        core.emit('player:special_currency_changed', playerId, newValue);
      });
      return true;
    },

    // 更新玩家属性 (通用方法，触发事件)
    updateAttribute: async (playerId, field, amount) => {
      const player = await core._playerService.get(playerId);
      if (!player) return false;
      
      const newChanges = {};
      newChanges[field] = (player[field] || 0) + amount;

      // 同步增加上限属性
      if (field === '生命') {
        newChanges.生命上限 = (player.生命上限 || 0) + amount;
      } else if (field === '魔法') {
        newChanges.魔法上限 = (player.魔法上限 || 0) + amount;
      }
      
      await core._playerService.modify({ playerId, changes: newChanges, source: `player:updateAttribute:${field}` });
      
      // 触发属性变化事件
      setImmediate(() => {
        core.emit('player:attribute_changed', playerId, field, newChanges[field]);
      });
      return true;
    }
  };

  core.registerDataSource('玩家', {
    description: '当前玩家数据',
    fields: ['昵称','等级','经验','生命','生命上限','魔法','魔法上限','攻击','防御','暴击率','闪避率','金币','银币','铜币','特殊货币','职业途径','职业序列','当前地图'],
    resolve: async (对象, 字段, ctx) => {
      const p = await ctx.core._playerService.get(ctx.playerId);
      if (!p) return undefined;
      const map = { '金币':'货币1', '银币':'货币2', '铜币':'货币3' };
      return p[map[字段] || 字段];
    }
  });

  return {
    moduleName: 'player',
    ...playerExports
  };
}

// ??????????
playerModule.moduleName = 'player';
playerModule.dependencies = ['database'];

module.exports = playerModule;
