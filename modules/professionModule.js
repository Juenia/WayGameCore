/**
 * 职业系统模块 - 提供职业途径与序列管理功能
 */
async function professionModule(core) {
  core.log('info', '正在加载职业系统模块...');

  // 1. 初始化数据库表
  if (core.db) {
    // 检查表结构并动态添加缺失的列
    const tableInfo = await core.db.all("PRAGMA table_info(professions)");
    if (!tableInfo.some(col => col.name === 'transfer_conditions')) {
      await core.db.exec("ALTER TABLE professions ADD COLUMN transfer_conditions TEXT DEFAULT '{}'");
    }
    if (!tableInfo.some(col => col.name === 'transfer_cost')) {
      await core.db.exec("ALTER TABLE professions ADD COLUMN transfer_cost TEXT DEFAULT '[]'");
    }

    // 插入默认数据
    const count = await core.db.get('SELECT COUNT(*) as count FROM professions');
    if (count.count === 0) {
      const { worldSeed } = require('./world/load.js');

      const defaultProfessions = [
        {
          name: "战士",
          description: "近战物理职业，拥有强大的生存能力和爆发力。",
          growth_curve: { "攻击": 2, "生命": 10 },
          default_skills: ["重击"],
          sequences: [
            {
              name: "见习战士",
              level: 1,
              attribute_growth: { "攻击": 5, "生命": 50 },
              skills: [],
              promotion_cost: [],
              promotion_conditions: {}
            },
            {
              name: "正式战士",
              level: 10,
              attribute_growth: { "攻击": 15, "防御": 10, "生命": 100 },
              skills: ["旋风斩"],
              promotion_cost: [{ type: "currency", currency_id: 1, amount: 500 }],
              promotion_conditions: { 位置: "新手村" }
            }
          ],
          transfer_conditions: { level: 1 },
          transfer_cost: []
        }
      ];

      // ── 世界种子合并（2026-09-19）────────────────────────────────────────────
      // modules/world/professions.json 是从当前正式世界（data/game.db）导出的内容种子，
      // 是唯一真源；上面的内置 战士 只在种子文件缺失/为空时兜底。已有库完全不受影响
      // （下面的写入本来只在职业表为空时执行）；name 是主键，OR IGNORE 再兜一层防重。
      const seedProfessions = worldSeed('professions', defaultProfessions);

      for (const prof of seedProfessions) {
        await core.db.run(
          'INSERT OR IGNORE INTO professions (name, description, growth_curve, default_skills, sequences, transfer_conditions, transfer_cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            prof.name, 
            prof.description, 
            JSON.stringify(prof.growth_curve), 
            JSON.stringify(prof.default_skills), 
            JSON.stringify(prof.sequences),
            JSON.stringify(prof.transfer_conditions),
            JSON.stringify(prof.transfer_cost)
          ]
        );
      }
      core.log('info', `已初始化了 ${seedProfessions.length} 个世界职业。`);
    }

    // 默认消息模板将由 GameSystem 统一管理，此处不再直接插入数据库
  }

  // 辅助方法：解析 JSON 字段
  const parseJson = (str, fallback = []) => {
    try {
      return str ? JSON.parse(str) : fallback;
    } catch (e) {
      return fallback;
    }
  };

  // 辅助方法：获取职业配置
  const getProfession = async (name) => {
    const row = await core.db.get('SELECT * FROM professions WHERE name = ?', [name]);
    if (row) {
      row.growth_curve = parseJson(row.growth_curve, {});
      row.default_skills = parseJson(row.default_skills, []);
      row.sequences = parseJson(row.sequences, []);
      row.transfer_conditions = parseJson(row.transfer_conditions, {});
      row.transfer_cost = parseJson(row.transfer_cost, []);
    }
    return row;
  };

  // 辅助方法：应用属性增长
  const applyGrowth = (player, growth) => {
    if (!growth) return [];
    const changes = [];
    const playerChanges = {}; // Collect changes for player modify
    for (const [attr, value] of Object.entries(growth)) {
      playerChanges[attr] = (player[attr] || 0) + value;
      
      // 同步增加上限属性
      if (attr === '生命') {
        playerChanges.生命上限 = (player.生命上限 || 0) + value;
      } else if (attr === '魔法') {
        playerChanges.魔法上限 = (player.魔法上限 || 0) + value;
      }
      
      const alias = core.getAlias(attr);
      changes.push(`${alias}+${value}`);
    }
    // Note: This helper directly modifies player object for now,
    // but in new arch, it should return changes for services.player.modify
    // For now, it modifies 'player' object passed by reference for simplicity
    // and callers will pick up changes for services.player.modify
    Object.assign(player, playerChanges); // Apply changes to the passed player object
    return changes;
  };

  const professionSystem = {
    /**
     * 获取职业配置
     */
    getProfession,

    /**
     * 应用属性增长
     */
    applyGrowth,

    /**
     * 保存职业配置
     */
    saveProfession: async (name, data) => {
      const growth_curve = JSON.stringify(data.growth_curve || {});
      const default_skills = JSON.stringify(data.default_skills || []);
      const sequences = JSON.stringify(data.sequences || []);
      const transfer_conditions = JSON.stringify(data.transfer_conditions || {});
      const transfer_cost = JSON.stringify(data.transfer_cost || []);

      const existing = await core.db.get('SELECT name FROM professions WHERE name = ?', [name]);
      if (existing) {
        await core.db.run(
          'UPDATE professions SET description = ?, growth_curve = ?, default_skills = ?, sequences = ?, transfer_conditions = ?, transfer_cost = ? WHERE name = ?',
          [data.description || '', growth_curve, default_skills, sequences, transfer_conditions, transfer_cost, name]
        );
      } else {
        await core.db.run(
          'INSERT INTO professions (name, description, growth_curve, default_skills, sequences, transfer_conditions, transfer_cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [name, data.description || '', growth_curve, default_skills, sequences, transfer_conditions, transfer_cost]
        );
      }
    },

    /**
     * 删除职业配置
     */
    deleteProfession: async (name) => {
      await core.db.run('DELETE FROM professions WHERE name = ?', [name]);
    }
  };

  // 辅助方法：授予技能
  const grantSkills = async (playerId, skillNames, services) => {
    const granted = [];
    const skillMod = core.getModule('skill');
    
    for (const skillName of skillNames) {
      if (skillMod && skillMod.addSkillToPlayer) {
        await skillMod.addSkillToPlayer(playerId, skillName, services);
        granted.push(skillName);
      } else {
        // Fallback logic, should not be reached if skill module is loaded and working
        core.log('warn', `技能模块未提供 addSkillToPlayer 方法，尝试直接修改玩家技能列表 (playerId: ${playerId}, skill: ${skillName})`);
        const player = await services.player.get(playerId);
        const currentSkills = Array.isArray(player.skills) ? player.skills : [];
        if (!currentSkills.includes(skillName)) {
          const newSkills = [...currentSkills];
          await services.player.modify({ playerId, changes: { 技能: newSkills }, source: 'profession:grant_skill_fallback', noEmit: true });
          granted.push(skillName);
        }
      }
    }
    return granted;
  };

  // 辅助方法：检查条件 (等级、属性、位置、道具等)
  const checkConditions = async (playerId, player, cond, type = 'promote', services) => {
    if (!cond) return null;

    // 获取包含被动技能加成的有效属性
    const skillMod = core.getModule('skill');
    const passiveBonuses = skillMod ? await skillMod.getPassiveBonuses(playerId, services) : {};
    const effectivePlayer = { ...player };
    for (const [attr, val] of Object.entries(passiveBonuses)) {
      effectivePlayer[attr] = (effectivePlayer[attr] || 0) + val;
    }

    // 1. 等级检查
    if (cond.level && effectivePlayer.等级 < cond.level) {
      return { status: 'fail_level', data: { attr: '等级', value: cond.level, level: cond.level, current_level: effectivePlayer.等级 }, templateKey: `profession:${type}.fail_level` };
    }

    // 2. 属性检查
    const attrFields = ['生命', '魔法', '攻击', '防御', '暴击率', '暴击伤害', '闪避率'];
    for (const attr of attrFields) {
      if (cond[attr] && (effectivePlayer[attr] || 0) < cond[attr]) {
        return { status: 'fail_condition', data: { attr: core.getAlias(attr), value: cond[attr] }, templateKey: `profession:${type}.fail_condition` };
      }
    }

    // 3. 位置检查 (支持 player.位置 或 player.当前地图)
    const currentLoc = effectivePlayer.位置 || effectivePlayer.当前地图;
    if (cond.位置 && currentLoc !== cond.位置) {
      return { status: 'fail_condition', data: { attr: '位置', value: cond.位置, location: cond.位置 }, templateKey: `profession:${type}.fail_condition` };
    }

    // 4. 拥有道具检查 (不扣除)
    if (cond.required_items && Array.isArray(cond.required_items)) {
      const backpack = core.getModule('backpack');
      if (backpack) {
        for (const item of cond.required_items) {
          const count = await backpack.getItemCount?.(playerId, item.name, services) || 0; // Pass services to backpack
          if (count < (item.quantity || 1)) {
            return { status: 'fail_condition', data: { attr: '道具', item: item.name, value: `${item.name} x${item.quantity || 1}`, quantity: item.quantity || 1 }, templateKey: `profession:${type}.fail_condition` };
          }
        }
      }
    }

    // 5. 任务检查
    if (cond.quest) {
      const questMod = core.getModule('quest');
      if (questMod) {
        const isCompleted = await questMod.isQuestCompleted?.(playerId, cond.quest, services); // Pass services to quest
        if (!isCompleted) {
          return { status: 'fail_condition', data: { attr: '任务', value: cond.quest, quest: cond.quest }, templateKey: `profession:${type}.fail_condition` };
        }
      }
    }

    return null; // 满足所有条件
  };

  // 辅助方法：检查并执行消耗
  const checkAndApplyCosts = async (playerId, player, costs, type = 'promote', services) => {
    if (!costs || !Array.isArray(costs)) return { changes: {}, error: null }; // Return changes object

    const playerChanges = {};

    // 先检查
    for (const cost of costs) {
      if (cost.type === 'currency') {
        const field = core.services.player.currencyField(cost.currency_id);
        if ((player[field] || 0) < cost.amount) {
          const alias = await services.query.getAlias(field) || field; // Assuming an alias system is available via query
          return { changes: {}, error: { status: 'fail_cost', data: { amount: cost.amount, currency: alias }, templateKey: `profession:${type}.fail_cost` } };
        }
      } else if (cost.type === 'item') {
        const backpack = core.getModule('backpack');
        if (backpack) {
          const count = await backpack.getItemCount?.(playerId, cost.item_name, services) || 0;
          if (count < cost.quantity) {
            return { changes: {}, error: { status: 'fail_cost', data: { amount: cost.quantity, currency: cost.item_name }, templateKey: `profession:${type}.fail_cost` } };
          }
        }
      }
    }

    // 执行扣除
    for (const cost of costs) {
      if (cost.type === 'currency') {
        const field = core.services.player.currencyField(cost.currency_id);
        playerChanges[field] = (player[field] || 0) - cost.amount;
      } else if (cost.type === 'item') {
        const backpack = core.getModule('backpack');
        if (backpack && backpack.removeItem) {
          await backpack.removeItem(playerId, cost.item_name, cost.quantity, services);
        }
      }
    }

    return { changes: playerChanges, error: null };
  };

  core.registerModule('profession', {
    doors: [
      { logical_name: 'profession:transfer', default_triggers: ['转职途径', '转职'], description: '选择并转职到指定途径' },
      { logical_name: 'profession:promote', default_triggers: ['晋升'], description: '提升当前职业序列' },
      { logical_name: 'profession:info', default_triggers: ['职业信息'], description: '查看自己的职业状态' },
      { logical_name: 'profession:list', default_triggers: ['职业列表'], description: '列出所有可用的职业途径' },
      { logical_name: 'profession:view', default_triggers: ['职业详情', '查看职业'], description: '查看指定职业途径的详细信息' }
    ],
    templates: {
      'profession:transfer.success': { text: '✨ 转职成功！\n途径：[职业途径]\n序列：[职业序列]\n属性变化：[职业序列成长属性]\n获得技能：[职业序列技能]', markdown: '✨ 转职成功！\n途径：[职业途径]\n序列：[职业序列]\n属性变化：[职业序列成长属性]\n获得技能：[职业序列技能]' },
      'profession:transfer.fail_not_exists': { text: '❌ 职业途径 [职业途径] 不存在。', markdown: '❌ 职业途径 [职业途径] 不存在。' },
      'profession:transfer.fail_condition': { text: '❌ 转职失败：未满足条件 {attr} ({value})。', markdown: '❌ 转职失败：未满足条件 {attr} ({value})。' },
      'profession:transfer.fail_level': { text: '❌ 转职失败：需要等级 {level}，当前等级 {current_level}。', markdown: '❌ 转职失败：需要等级 {level}，当前等级 {current_level}。' },
      'profession:transfer.fail_cost': { text: '❌ 消耗不足：需要 {amount} {currency}。', markdown: '❌ **消耗不足**：需要 `{amount}` {currency}。' },
      'profession:transfer.fail_no_class': { text: '❌ 当前职业不允许转职。', markdown: '❌ 当前职业不允许转职。' },
      'profession:transfer.fail_sequence': { text: '❌ 该职业序列配置丢失。', markdown: '❌ 该职业序列配置丢失。' },
      'profession:promote.success': { text: '🎊 晋升成功！\n新序列：[职业序列]\n属性增长：[职业序列成长属性]\n获得技能：[职业序列技能]', markdown: '🎊 晋升成功！\n新序列：[职业序列]\n属性增长：[职业序列成长属性]\n获得技能：[职业序列技能]' },
      'profession:promote.fail_condition': { text: '❌ 晋升失败：未满足条件 {attr} ({value})。', markdown: '❌ 晋升失败：未满足条件 {attr} ({value})。' },
      'profession:promote.fail_level': { text: '❌ 晋升失败：需要等级 {level}，当前等级 {current_level}。', markdown: '❌ 晋升失败：需要等级 {level}，当前等级 {current_level}。' },
      'profession:promote.fail_cost': { text: '❌ 消耗品不足：需要 {amount} {currency}。', markdown: '❌ 消耗品不足：需要 {amount} {currency}。' },
      'profession:info.success': {
        text: '📜 【职业信息】\n途径：{professionName}\n序列：{sequenceName}\n简介：{description}\n成长曲线：{growthCurve}',
        markdown: '📜 【职业信息】\n途径：**{professionName}**\n序列：**{sequenceName}**\n简介：{description}\n成长曲线：{growthCurve}'
      },
      'profession:info.no_profession': { text: '你目前没有任何职业。', markdown: '你目前没有任何职业。' },
      'profession:list.success': { text: '🗺️ 【职业列表】\n{list}', markdown: '🗺️ 【职业列表】\n{list}' },
      'profession:list.empty': { text: '目前没有任何职业可选。', markdown: '目前没有任何职业可选。' },
      'profession:view.success': {
        text: '📜 【职业详情：{professionName}】\n简介：{description}\n成长曲线：{growthCurve}\n序列列表：\n{sequenceList}',
        markdown: '📜 【职业详情：**{professionName}**】\n简介：{description}\n成长曲线：{growthCurve}\n序列列表：\n{sequenceList}'
      },
      'profession:view.fail_not_exists': { text: '❌ 职业途径 [职业途径] 不存在。', markdown: '❌ 职业途径 [职业途径] 不存在。' }
    },
    handlers: {
      'profession:transfer': async (request) => {
        const { playerId, args, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };

        const professionName = args[0];
        if (!professionName) {
          return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };
        }

        const prof = await getProfession(professionName);
        if (!prof) {
          return { status: 'fail_not_exists', data: { professionName }, templateKey: 'profession:transfer.fail_not_exists' };
        }

        if (player.职业途径 === prof.name) {
          return { status: 'fail_already_this_profession', templateKey: 'system.info', data: { message: `你已经是 ${prof.name} 了，无需重复转职。` } };
        }

        // 检查转职条件
        const condError = await checkConditions(playerId, player, prof.transfer_conditions, 'transfer', services);
        if (condError) return condError; // Will be { status, data, templateKey }

        // 检查转职消耗 (可选)
        const { changes: costChanges, error: costError } = await checkAndApplyCosts(playerId, player, prof.transfer_cost, 'transfer', services);
        if (costError) return costError;

        // 找到初始序列 (直线晋升模型：取第一个序列)
        const initialSeq = prof.sequences[0];
        if (!initialSeq) {
          return { status: 'fail_no_sequence', templateKey: 'system.error', data: { message: '该职业途径尚未配置任何序列。' } };
        }

        const playerChanges = {
          ...costChanges, // Apply cost changes first
          职业途径: prof.name,
          职业序列: initialSeq.name,
        };

        // 授予途径默认技能和序列技能
        const skillsToGrant = [...prof.default_skills, ...(initialSeq.skills || [])];
        const grantedSkills = await grantSkills(playerId, skillsToGrant, services);

        // 应用初始序列属性增长
        // Note: applyGrowth modifies the player object, so we need to copy initial player first if we want to track explicit changes
        // For simplicity, we apply to a temp object and merge changes
        const tempPlayerForGrowth = { ...player, ...playerChanges }; // Apply current changes for growth calculation
        const growthChangesArr = applyGrowth(tempPlayerForGrowth, initialSeq.attribute_growth);
        Object.assign(playerChanges, tempPlayerForGrowth); // Merge changes from growth back to playerChanges

        await services.player.modify({ playerId, changes: playerChanges, source: 'profession:transfer' });

        // 2026-09-20：转职成功从来没发过事件（晋升那边有 emit），
        // 监听 player:class_changed 的模块（任务/成就那类）拿不到转职信号 —— 新冒烟实测事件不达。
        await core.emit('player:class_changed', playerId, prof.name);

        return {
          status: 'success',
          data: {
            professionName: prof.name,
            sequenceName: initialSeq.name,
            growthChanges: growthChangesArr.join('，') || '无',
            grantedSkills: grantedSkills.join('，') || '无',
            // 2026-09-20：模板里写的是 [职业途径]/[职业序列]/[职业序列成长属性]/[职业序列技能]，
            // 而这里只给了英文字段 → 玩家看到的是一句「✨ 恭喜！你已成功转职为 ！」（全空）。
            // 中文键是模板要的，英文键留给别处引用，两套都给。
            职业途径: prof.name,
            职业序列: initialSeq.name,
            职业序列成长属性: growthChangesArr.join('，') || '无',
            职业序列技能: grantedSkills.join('，') || '无'
          },
          templateKey: 'profession:transfer.success'
        };
      },

      'profession:promote': async (request) => {
        const { playerId, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };

        if (!player.职业途径 || player.职业途径 === '无') {
          return { status: 'fail_no_profession', templateKey: 'system.info', data: { message: '你还没有职业途径，请先执行 /转职途径。' } };
        }

        const prof = await getProfession(player.职业途径);
        if (!prof) return { status: 'fail_config_missing', templateKey: 'system.error', data: { message: '当前职业途径配置已丢失。' } };

        const currentIndex = prof.sequences.findIndex(s => s.name === player.职业序列);
        if (currentIndex === -1) return { status: 'fail_sequence_config_missing', templateKey: 'system.error', data: { message: '未找到当前序列配置。' } };
        
        const nextSeq = prof.sequences[currentIndex + 1];
        if (!nextSeq) {
          return { status: 'fail_max_sequence', templateKey: 'system.info', data: { message: '你已达到当前途径的最高序列，无法继续晋升。' } };
        }

        // 检查晋升条件 (包含位置、拥有道具等)
        const condError = await checkConditions(playerId, player, nextSeq.promotion_conditions, 'promote', services);
        if (condError) return condError;

        // 检查并执行晋升消耗 (包含扣除)
        const { changes: costChanges, error: costError } = await checkAndApplyCosts(playerId, player, nextSeq.promotion_cost, 'promote', services);
        if (costError) return costError;

        const playerChanges = {
          ...costChanges,
          职业序列: nextSeq.name,
        };

        // 授予序列技能
        const grantedSkills = await grantSkills(playerId, nextSeq.skills || [], services);

        // 应用序列属性增长
        const tempPlayerForGrowth = { ...player, ...playerChanges };
        const growthChangesArr = applyGrowth(tempPlayerForGrowth, nextSeq.attribute_growth);
        Object.assign(playerChanges, tempPlayerForGrowth);

        await services.player.modify({ playerId, changes: playerChanges, source: 'profession:promote' });

        // 触发晋升事件供任务系统等模块监听
        await core.emit('profession:promoted', playerId, nextSeq.name);

        return {
          status: 'success',
          data: {
            sequenceName: nextSeq.name,
            growthChanges: growthChangesArr.join('，') || '无',
            grantedSkills: grantedSkills.join('，') || '无',
            // 2026-09-20：同上 —— 晋升模板用 [职业序列]/[职业序列成长属性]/[职业序列技能]，补中文键
            职业序列: nextSeq.name,
            职业序列成长属性: growthChangesArr.join('，') || '无',
            职业序列技能: grantedSkills.join('，') || '无'
          },
          templateKey: 'profession:promote.success'
        };
      },

      'profession:info': async (request) => {
        const { playerId, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };

        if (!player.职业途径) {
          return { status: 'no_profession', templateKey: 'profession:info.no_profession' };
        }

        const prof = await getProfession(player.职业途径);
        if (!prof) return { status: 'fail_config_missing', templateKey: 'system.error', data: { message: '未找到职业配置。' } };

        return {
          status: 'success',
          data: {
            professionName: prof.name,
            sequenceName: player.职业序列,
            description: prof.description,
            growthCurve: Object.entries(prof.growth_curve).map(([k, v]) => `${k}+${v}`).join(', ')
          },
          templateKey: 'profession:info.success'
        };
      },

      'profession:list': async (request) => {
        const rows = await core.db.all('SELECT name, description FROM professions');
        if (rows.length === 0) return { status: 'empty', templateKey: 'profession:list.empty' };

        const listStr = rows.map(r => `• ${r.name}：${r.description}`).join('\n');
        return {
          status: 'success',
          data: { list: listStr },
          templateKey: 'profession:list.success'
        };
      },

      'profession:view': async (request) => {
        const { args } = request;
        const name = args[0];
        if (!name) return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };

        const prof = await getProfession(name);
        if (!prof) {
          return { status: 'fail_not_exists', data: { professionName: name }, templateKey: 'profession:view.fail_not_exists' };
        }

        const seqsStr = prof.sequences.map((s, index) => {
          const growth = Object.entries(s.attribute_growth || {}).map(([k, v]) => `${k}+${v}`).join(', ');
          const skills = (s.skills || []).join(', ');
          return `▫️ ${s.name}${index === 0 ? ' (初始)' : ''}\n   成长：${growth || '无'}\n   技能：${skills || '无'}`;
        }).join('\n');

        return {
          status: 'success',
          data: {
            professionName: prof.name,
            description: prof.description,
            growthCurve: Object.entries(prof.growth_curve).map(([k, v]) => `${k}+${v}`).join(', '),
            sequenceList: seqsStr
          },
          templateKey: 'profession:view.success'
        };
      }
    }
  });

  // 3. 监听玩家创建事件，设置初始职业序列
  core.on('player:created', async (playerId, playerData) => {

  // This event listener needs access to services.player.modify
  if (core.services && core.services.player) {
      if (playerData.职业途径 && playerData.职业途径 !== '无') {
        const prof = await getProfession(playerData.职业途径);
       
       if (prof && prof.sequences && prof.sequences.length > 0) { 
         const initialSeq = prof.sequences[0]; 
         
         const playerChanges = { 
           职业序列: initialSeq.name, 
         }; 
         
         // ★★★ 临时注释掉这两个 await，看是否能通过 
         if (initialSeq.growth) { 
           Object.entries(initialSeq.growth).forEach(([attr, val]) => { 
             playerChanges[attr] = (playerChanges[attr] || 0) + val; 
           }); 
         } 
         const tempPlayerForGrowth = { ...playerData, ...playerChanges }; 
         applyGrowth(tempPlayerForGrowth, initialSeq.attribute_growth); 
         Object.assign(playerChanges, tempPlayerForGrowth); 
        
       }
     }
   } else {
     core.log('warn', '无法在 player:created 事件中获取 core.services.player，未能处理初始职业序列。');
   }
  });
 

  // 4. 监听玩家升级事件，应用职业成长曲线
  core.on('player:level_up', async (playerId, oldLv, newLv) => {
    if (oldLv <= 0 || newLv <= oldLv) return;

    if (core.services && core.services.player) {
      const player = await core.services.player.get(playerId);
      if (!player || !player.职业途径 || player.职业途径 === '无') return;

      const prof = await getProfession(player.职业途径);
      if (!prof || !prof.growth_curve) return;

      const levelsGained = newLv - oldLv;
      if (levelsGained <= 0) return;

      core.log('debug', `Player ${playerId} (Lv ${oldLv} -> ${newLv}) profession growth from:`, prof.growth_curve);
      core.log('debug', `Levels gained: ${levelsGained}`);
      const totalGrowth = {};
      for (const [attr, value] of Object.entries(prof.growth_curve)) {
        core.log('debug', `Calculating total growth for ${attr}: ${value} * ${levelsGained} = ${value * levelsGained}`);
        totalGrowth[attr] = value * levelsGained;
      }

      const playerChanges = {};
      const tempPlayerForGrowth = { ...player, ...playerChanges };
      const growthChangesArr = applyGrowth(tempPlayerForGrowth, totalGrowth);
      Object.assign(playerChanges, tempPlayerForGrowth);
      
      if (growthChangesArr.length > 0) {
        await core.services.player.modify({ playerId, changes: playerChanges, source: 'profession:level_up' });
        core.log('info', `玩家 ${player.昵称} 升级触发职业成长：${growthChangesArr.join(', ')}`);
      }
    } else {
      core.log('warn', '无法在 player:level_up 事件中获取 core.services.player，未能应用职业成长。' );
    }
  });

  // 4. 注册系统变量
  core.registerSystemVariable('职业途径', (playerId, core, context) => context.职业途径 || '');
  core.registerSystemVariable('职业序列', (playerId, core, context) => context.职业序列 || '');
  core.registerSystemVariable('职业简介', (playerId, core, context) => context.职业简介 || '');
  core.registerSystemVariable('职业途径成长曲线', (playerId, core, context) => context.职业途径成长曲线 || '');
  core.registerSystemVariable('职业途径技能', (playerId, core, context) => context.职业途径技能 || '');
  core.registerSystemVariable('职业序列成长属性', (playerId, core, context) => context.职业序列成长属性 || '');
  core.registerSystemVariable('职业序列技能', (playerId, core, context) => context.职业序列技能 || '');
  core.registerSystemVariable('职业序列晋升条件', (playerId, core, context) => context.职业序列晋升条件 || '');
  core.registerSystemVariable('职业序列晋升消耗', (playerId, core, context) => context.职业序列晋升消耗 || '');

  core.log('info', '职业系统模块加载完成。');

  core.registerDataSource('职业', {
    description: '职业定义表',
    fields: ['名称','简介','序列'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM professions WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','简介':'description','序列':'sequences' };
      return row[map[字段]];
    }
  });

  return {
    moduleName: 'profession',
    ...professionSystem
  };
}

professionModule.moduleName = 'profession';
professionModule.dependencies = ['database', 'player'];

module.exports = professionModule;