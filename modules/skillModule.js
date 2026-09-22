/**
 * 技能模块 - 处理技能数据管理、查询、使用及与战斗系统的集成
 */
async function skillModule(core) {
  core.log('info', '正在加载技能模块...');

  const db = core.db;
  if (!db) {
    throw new Error('技能模块加载失败：数据库模块未就绪。');
  }

  // 1. 初始化数据库表
  // 检查现有 skills 表结构，如果与预期不符则重新创建
  const tableInfo = await db.all("PRAGMA table_info(skills)");
  const hasCost = tableInfo.some(col => col.name === 'cost');
  const hasTarget = tableInfo.some(col => col.name === 'effect_target');
  
  if (tableInfo.length > 0 && (!hasCost || !hasTarget)) {
    core.log('warn', '检测到旧版技能表结构，正在迁移...');
    await db.run("DROP TABLE skills");
  }

  await db.run(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      description TEXT,
      cost TEXT, -- 存储 JSON 字符串
      effect TEXT,
      effect_value REAL,
      effect_target TEXT,
      effect_value_str TEXT
    )
  `);

  // 2. 插入默认技能数据
  const { worldSeed } = require('./world/load.js');
  const defaultSkills = [
    {
      name: '重击',
      description: '汇聚全身力气的一击，造成大量伤害。',
      cost: JSON.stringify({ 魔法: 5 }),
      effect: '攻击',
      effect_value: 20
    },
    {
      name: '治疗术',
      description: '使用自然之力恢复伤口。',
      cost: JSON.stringify({ 魔法: 10 }),
      effect: '治疗',
      effect_value: 30
    },
    {
      name: '旋风斩',
      description: '快速旋转武器，对周围敌人造成伤害。',
      cost: JSON.stringify({ 魔法: 15 }),
      effect: '攻击',
      effect_value: 40
    }
  ];

  // ── 世界种子合并（2026-09-19）──────────────────────────────────────────────
  // modules/world/skills.json 是从当前正式世界（data/game.db）导出的内容种子，是唯一真源；
  // 上面的三个内置技能只在种子文件缺失/为空时兜底。已有库完全不受影响（INSERT OR IGNORE）。
  // 种子技能比内置技能多几列（作用目标/类型/冷却…），所以这里写全列，形状照表默认值对齐。
  const seedSkills = worldSeed('skills', defaultSkills).map((s) => ({
    name: s.name,
    description: s.description || '',
    cost: typeof s.cost === 'string' ? s.cost : JSON.stringify(s.cost || {}),
    effect: s.effect || '',
    effect_value: s.effect_value || 0,
    effect_target: s.effect_target || '',
    effect_value_str: s.effect_value_str || '',
    target: s.target || '敌人',
    type: s.type || '主动',
    cooldown: s.cooldown || 0,
    duration: s.duration || 0
  }));
  for (const skill of seedSkills) {
    try {
      await db.run(
        'INSERT OR IGNORE INTO skills (name, description, cost, effect, effect_value, effect_target, effect_value_str, target, type, cooldown, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [skill.name, skill.description, skill.cost, skill.effect, skill.effect_value, skill.effect_target, skill.effect_value_str, skill.target, skill.type, skill.cooldown, skill.duration]
      );
    } catch (err) {
      core.log('warn', `插入默认技能 ${skill.name} 失败: ${err.message}`);
    }
  }

  // 3. 消息模板将由 GameSystem 统一管理，此处不再直接插入数据库
  // const defaultTemplates ... (removed)

  // 3.5 注册系统变量
  const skillVars = [
    { name: '技能名', getter: (p, core, ctx) => ctx.技能名 !== undefined ? ctx.技能名 : (ctx.name !== undefined ? ctx.name : '[技能名]') },
    { name: '技能简介', getter: (p, core, ctx) => ctx.技能简介 !== undefined ? ctx.技能简介 : (ctx.description !== undefined ? ctx.description : '[技能简介]') },
    { name: '技能消耗', getter: (p, core, ctx) => {
      if (ctx.技能消耗 !== undefined) return ctx.技能消耗;
      if (ctx.cost) return Object.entries(ctx.cost).map(([k,v])=>`${k}${v}`).join(',');
      return '[技能消耗]';
    }},
    { name: '技能消耗值', getter: (p, core, ctx) => ctx.技能消耗值 !== undefined ? ctx.技能消耗值 : '[技能消耗值]' },
    { name: '技能效果', getter: (p, core, ctx) => ctx.技能效果 !== undefined ? ctx.技能效果 : (ctx.effect !== undefined ? ctx.effect : '[技能效果]') },
    { name: '技能效果目标', getter: (p, core, ctx) => ctx.技能效果目标 !== undefined ? ctx.技能效果目标 : (ctx.effect_target !== undefined ? ctx.effect_target : '[技能效果目标]') },
    { name: '技能效果值', getter: (p, core, ctx) => ctx.技能效果值 !== undefined ? ctx.技能效果值 : (ctx.effect_value !== undefined ? ctx.effect_value : '[技能效果值]') },
    { name: '技能效果简述', getter: (p, core, ctx) => ctx.技能效果简述 !== undefined ? ctx.技能效果简述 : '[技能效果简述]' },
    { name: '技能列表', getter: (p, core, ctx) => ctx.技能列表 !== undefined ? ctx.技能列表 : '[技能列表]' }
  ];

  skillVars.forEach(v => core.registerSystemVariable(v.name, v.getter));

  // 4. 核心逻辑方法
  const skillSystem = {
    /**
     * 获取技能定义
     */
    getSkillDefinition: async (name) => {
      const row = await db.get('SELECT * FROM skills WHERE name = ?', [name]);
      if (row && typeof row.cost === 'string') {
        try { row.cost = JSON.parse(row.cost); } catch (e) { row.cost = {}; }
      }
      return row;
    },

    /**
     * 获取玩家拥有的技能列表
     */
    getPlayerSkills: async (playerId, services) => {
      const svc = services || core.services;
      const player = await svc.player.get(playerId);
      if (!player) return [];
      // 兼容：技能可能在 player.技能 或 player.skills
      const raw = player.技能 || player.skills;
      if (Array.isArray(raw)) return raw;
      if (raw && typeof raw === 'object') return Object.keys(raw);
      return [];
    },

    /**
     * 获取玩家所有被动技能加成
     */
    getPassiveBonuses: async (playerId, services) => {
      const ownedNames = await skillSystem.getPlayerSkills(playerId, services);
      const bonuses = {};
      
      for (const name of ownedNames) {
        const skill = await skillSystem.getSkillDefinition(name);
        if (skill && skill.effect === '被动') {
          const target = skill.effect_target || '防御';
          bonuses[target] = (bonuses[target] || 0) + (skill.effect_value || 0);
        }
      }
      return bonuses;
    },

    /**
     * getPassiveBonuses 的别名，兼容用户需求
     */
    getPassiveBonus: async (playerId, services) => {
      return await skillSystem.getPassiveBonuses(playerId, services);
    },

    /**
     * 为玩家添加技能
     */
    addSkillToPlayer: async (playerId, skillName, services, opts) => {
      const player = await services.player.get(playerId);
      if (!player) return false;
      if (player.parseError) {
        core.log('warn', `尝试为玩家 ${playerId} 添加技能时，发现其数据已损坏。`);
        return false;
      }
      const currentSkills = Array.isArray(player.技能) ? player.技能 : [];
      if (currentSkills.includes(skillName)) return true;
      const newSkills = [...currentSkills, skillName];
      // 2026-09-20 修复：这里原来走 services.player.modify({技能})，而 modify 是
      // 「读整份玩家 → 改一个字段 → 写回整份」—— 它挂在 player:created 链上（核心的 emit 走
      // setImmediate，注册返回时监听器还没跑），于是会和调用方的写入**交叠**：
      // 它读到的是注册那一刻的旧玩家，写回时就把别人刚改的属性一起盖回旧值。
      // 实测：注册后立刻把等级改成 8，被本函数的写回覆盖成 1（连 get() 读回来都是 1）；
      // 证据见 tools/verify-consumable-effects.js 里的「注册后立刻改属性」回归断言。
      // 技能只活在 player_skills 这一张表里，所以这里只写这一张表 + 同步内存的技能字段，
      // 一个字节都不碰 players / player_attributes —— 从根上不再有「写回旧属性」这回事。
      const writeSkill = () => core.db.playerDb.run(
        'INSERT OR IGNORE INTO player_skills (player_id, skill_name, learned_at) VALUES (?, ?, ?)',
        [playerId, skillName, new Date().toISOString()]);
      await writeSkill();
      const mem = core.state && core.state.players && core.state.players[playerId];
      if (mem) mem.技能 = newSkills;
      if (opts && opts.ensureAfterRegister) {
        // 还要兜住**另一半**：savePlayer 是「DELETE 整张技能表 + 按它读到的玩家对象重写」，
        // 所以注册刚返回时若调用方先写了一次玩家（用道具/移动/改属性都算），那一次写入读到的是
        // 我们写之前的技能列表（空），会把刚学会的技能抹掉。这一半的确定性修法在核心（savePlayer
        // 整对象写，属禁改清单），模块层只能写完隔一拍复核、真被抹了就补回来。
        setTimeout(() => {
          core.db.playerDb.get('SELECT skill_name FROM player_skills WHERE player_id = ? AND skill_name = ?', [playerId, skillName])
            .then((row) => {
              if (!row) {
                if (mem) mem.技能 = (Array.isArray(mem.技能) ? mem.技能 : []).concat([skillName]);
                return writeSkill();
              }
              return null;
            })
            .catch(() => {});
        }, 400);
      }
      core.log('info', '玩家 ' + playerId + ' 学会了技能: ' + skillName);
      return true;
    },

    /**
     * 为玩家移除技能
     */
    removeSkillFromPlayer: async (playerId, skillName, services) => {
      const player = await services.player.get(playerId);
      if (!player) return false;
      const currentSkills = Array.isArray(player.技能) ? player.技能 : [];
      
      const index = currentSkills.indexOf(skillName);
      if (index > -1) {
        const newSkills = [...currentSkills];
        newSkills.splice(index, 1);
        await services.player.modify({ playerId, changes: { 技能: newSkills }, source: 'skill:remove' });
        core.log('info', `玩家 ${playerId} 移除了技能: ${skillName}, 当前技能: ${newSkills.join(',')}`);
        return true;
      }
      return false;
    },

    /**
     * 编辑器/内部调用：获取所有技能
     */
    getAllSkills: async () => {
      return await db.all('SELECT rowid AS id, * FROM skills');
    },

    /**
     * 编辑器/内部调用：保存技能
     */
    saveSkill: async (name, data) => {
      const now = new Date().toISOString();
      const cost = typeof data.cost === 'string' ? data.cost : JSON.stringify(data.cost || {});
      
      const existing = await db.get('SELECT name FROM skills WHERE name = ?', [name]);
      if (existing) {
        await db.run(
          'UPDATE skills SET description = ?, cost = ?, effect = ?, effect_value = ?, effect_target = ?, effect_value_str = ? WHERE name = ?',
          [data.description || '', cost, data.effect || '', data.effect_value || 0, data.effect_target || '', data.effect_value_str || '', name]
        );
      } else {
        await db.run(
          'INSERT INTO skills (name, description, cost, effect, effect_value, effect_target, effect_value_str) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [name, data.description || '', cost, data.effect || '', data.effect_value || 0, data.effect_target || '', data.effect_value_str || '']
        );
      }
    },

    /**
     * 编辑器/内部调用：删除技能
     */
    deleteSkill: async (name) => {
      await db.run('DELETE FROM skills WHERE name = ?', [name]);
    },

    /**
     * 使用技能核心逻辑
     */
    useSkill: async (playerId, skillName, services, context = {}) => {
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail', templateKey: 'system.player_not_found', data: {} };

      const skill = await skillSystem.getSkillDefinition(skillName);
      
      // 1. 检查拥有权 (已学会 或 装备附带)
      let isOwned = Array.isArray(player['技能']) && player['技能'].includes(skillName);
      let equipSkillDef = null;

      if (!isOwned) {
        // 检查装备附带技能
        const equipMod = core.getModule('equipment'); // Access core directly for modules
        if (equipMod && player.装备栏) {
          for (const slotId in player.装备栏) {
            const equipName = player.装备栏[slotId];
            if (equipName) {
              const def = equipMod.getDefinition(equipName);
              if (def && def.skill === skillName) {
                isOwned = true;
                equipSkillDef = {
                  name: skillName,
                  description: `装备 [${equipName}] 附带的技能。`,
                  cost: {}, // 装备技能通常无消耗
                  effect: '攻击',
                  effect_value: 0,
                  multiplier: 1.5,
                  cooldown: 3
                };
                break;
              }
            }
          }
        }
      }

      if (!isOwned) {
        return { status: 'fail_not_owned', data: { skillName }, templateKey: 'skill:use.fail.not_owned' };
      }

      const finalSkill = skill || equipSkillDef;
      if (!finalSkill) {
        return { status: 'fail_not_exist', data: { skillName }, templateKey: 'skill:query.fail' };
      }

      // 2. 检查消耗条件
      const cost = finalSkill.cost || {};
      const playerChanges = {}; // Collect changes
      for (const [attr, value] of Object.entries(cost)) {
        let targetAttr = attr;
        if (attr === '生命上限') targetAttr = '生命上限';
        else if (attr === '魔法上限') targetAttr = '魔法上限';
        
        let playerVal = player[targetAttr];
        if (playerVal === undefined) {
          if (targetAttr === '生命上限') playerVal = player.max生命;
          else if (targetAttr === '魔法上限') playerVal = player.max魔法;
        }
        
        if (playerVal === undefined || playerVal < value) {
          return {
            status: 'fail_resource',
            data: { skillName, resource: attr, required: value },
            templateKey: 'skill:use.fail.resource'
          };
        }
      }

      // 3. 扣除消耗
      for (const [attr, value] of Object.entries(cost)) {
        if (player[attr] !== undefined) {
          playerChanges[attr] = player[attr] - value;
        } else if (attr === '生命上限' && player.max生命 !== undefined) {
          playerChanges.max生命 = player.max生命 - value;
          if (player.生命 > playerChanges.max生命) playerChanges.生命 = playerChanges.max生命;
        } else if (attr === '魔法上限' && player.max魔法 !== undefined) {
          playerChanges.max魔法 = player.max魔法 - value;
          if (player.魔法 > playerChanges.max魔法) playerChanges.魔法 = playerChanges.max魔法;
        } else {
          playerChanges[attr] = (player[attr] || 0) - value;
        }
        // 确保不会扣成负数 (除了上限类属性)
        if (attr !== '生命上限' && attr !== '魔法上限' && playerChanges[attr] < 0) {
          playerChanges[attr] = 0;
        }
      }

      // 4. 执行效果
      let effectDesc = '';
      const effectValue = finalSkill.effect_value;
      
      const combat = core.getModule('combat'); // Access core directly for modules
      const isInCombat = combat && player.inCombat; // Assuming player.inCombat now tracks combat status

      switch (finalSkill.effect) {
        case '攻击':
          if (isInCombat) {
            effectDesc = `对 [怪物名] 造成了 ${effectValue} 点技能伤害。`;
            if (!context.isCombatRound) {
              const res = await combat.executeRound(playerId, { 
                type: 'skill', 
                skill: { ...finalSkill, multiplier: finalSkill.multiplier || 1.0, bonusDamage: effectValue } 
              }, services); // Pass services to combat module
              return res; // Combat module handles response
            }
          } else {
            effectDesc = `发起了攻击，造成了 ${effectValue} 点理论伤害。`;
          }
          break;
        case '治疗':
          const maxHp = player.生命上限 || player.max生命 || 100;
          const oldHp = player.生命;
          playerChanges.生命 = Math.min(maxHp, player.生命 + effectValue);
          effectDesc = `恢复了 ${playerChanges.生命 - oldHp} 点生命。`;
          if (isInCombat && !context.isCombatRound) {
            const res = await combat.executeRound(playerId, { type: 'none', message: effectDesc }, services); // Pass services
            return res;
          }
          break;
        case '传送':
          const targetMap = context.targetMap || skill.effect_value_str || '新手村';
          const oldMap = player.当前地图;
          playerChanges.当前地图 = targetMap;
          effectDesc = `从 ${oldMap} 传送到了 ${targetMap}。`;
          await core.emit('player:moved', playerId, oldMap, targetMap);
          break;
        case 'buff':
          const buffAttr = skill.effect_target || '攻击';
          playerChanges[buffAttr] = (player[buffAttr] || 0) + effectValue;
          effectDesc = `获得了持续强化，${buffAttr} 提升了 ${effectValue} 点。`;
          if (isInCombat && !context.isCombatRound) {
            const res = await combat.executeRound(playerId, { type: 'none', message: effectDesc }, services); // Pass services
            return res;
          }
          break;
        case '偷取':
          if (isInCombat) {
            // This part needs combat module to be aware of how to get monster instances
            // For now, assuming combat module provides this or pass services to it
            const combatMod = core.getModule('combat');
            const monsterInstance = combatMod.getMonsterInstance(playerId); // Assuming this method exists
            if (monsterInstance) {
              const monsterDef = combatMod.getMonsterDefinition(monsterInstance.definitionName);
              if (monsterDef.drops && monsterDef.drops.length > 0) {
                const drop = monsterDef.drops[Math.floor(Math.random() * monsterDef.drops.length)];
                if (drop.type === 'item') {
                  const backpack = core.getModule('backpack');
                  await backpack.addItem(playerId, drop.name, drop.quantity, services); // Pass services to backpack
                  effectDesc = `成功从 [怪物名] 身上偷取了 ${drop.name} x${drop.quantity}！`;
                } else if (drop.type === 'currency') {
                  const amount = Math.floor(drop.amount * 0.5) + 1;
                  playerChanges.金币 = (player.金币 || 0) + amount;
                  effectDesc = `成功从 [怪物名] 身上偷取了 ${amount} 金币！`;
                }
              } else {
                effectDesc = `试图从 [怪物名] 身上偷点什么，但它看起来一贫如洗。`;
              }
            } else {
              effectDesc = `未能找到目标怪物。`;
            }
            if (!context.isCombatRound) {
              const res = await combat.executeRound(playerId, { type: 'none', message: effectDesc }, services); // Pass services
              return res;
            }
          } else {
            effectDesc = `只能在战斗中使用偷取技能。`;
          }
          break;
        case '被动':
          effectDesc = `该技能是主动无法使用的被动效果。`;
          return { status: 'fail_passive', data: {}, templateKey: 'system.error' }; // Use a generic error template for now
        default:
          effectDesc = `触发了 ${finalSkill.effect} 效果，数值为 ${effectValue}。`;
      }

      // 5. 保存状态
      await services.player.modify({ playerId, changes: playerChanges, source: 'skill:use' });

      return {
        status: 'success',
        data: { skillName, effectDesc, skill: finalSkill },
        templateKey: 'skill:use.success'
      };
    }
  };

  const doors = [
    { logical_name: 'skill:query', default_triggers: ['查询技能'], aliases: ['skill info'], description: '查看技能详细信息' },
    { logical_name: 'skill:list', default_triggers: ['技能列表'], aliases: ['skills'], description: '查看已学会的技能列表' }
  ];

  const templates = {
    'skill:query.success': { text: '【[技能名]】\n简介：[技能简介]\n消耗：[技能消耗]\n效果：[技能效果] ([技能效果值])', markdown: '【**[技能名]**】\n简介：[技能简介]\n消耗：[技能消耗]\n效果：[技能效果] ([技能效果值])' },
    'skill:list.view': { text: '--- 我的技能 ---\n[技能列表]\n--- 输入 /查询技能 [技能名] 查看详情 ---', markdown: '--- **我的技能** ---\n[技能列表]\n--- 输入 /查询技能 [技能名] 查看详情 ---' },
    'skill:use.success': { text: '👌 你使用了 [技能名]！\n效果：[技能效果简述]', markdown: '👌 你使用了 **[技能名]**！\n效果：[技能效果简述]' },
    'skill:query.fail': { text: '❌ 技能 [技能名] 不存在。', markdown: '❌ 技能 **[技能名]** 不存在。' },
    'skill:list.empty': { text: '📭 你目前还没有学会任何技能。', markdown: '📭 你目前还没有学会任何技能。' },
    'skill:use.fail.resource': { text: '⚠️ 使用 [技能名] 失败：[技能消耗]不足 (需要[技能消耗值])。', markdown: '⚠️ 使用 **[技能名]** 失败：**[技能消耗]**不足 (需要[技能消耗值])。' },
    'skill:use.fail.not_owned': { text: '❌ 你还没有学会技能 [技能名]。', markdown: '❌ 你还没有学会技能 **[技能名]**。' }
  };

  const handlers = {
    'skill:query': async (request) => {
      const { playerId, args, services } = request;
      const skillName = args[0];
      if (!skillName) {
        return { status: 'fail_no_name', data: {}, templateKey: 'system.invalid_command_usage' }; // Use a generic system template for now
      }
  
      const skill = await skillSystem.getSkillDefinition(skillName);
      if (!skill) {
        return { status: 'fail_not_exist', data: { skillName }, templateKey: 'skill:query.fail' };
      }
  
      const ownedSkills = await skillSystem.getPlayerSkills(playerId, services);
      const isOwned = ownedSkills.includes(skillName);
  
      const costStr = Object.entries(skill.cost || {}).map(([k, v]) => `${k}${v}`).join(', ') || '无';
      
      return {
        status: 'success',
        data: {
          skillName: skill.name + (isOwned ? ' (已学会)' : ''),
          description: skill.description,
          cost: costStr,
          effect: skill.effect,
          effectTarget: skill.effect_target || '无',
          effectValue: skill.effect_value,
          ...skill
        },
        templateKey: 'skill:query.success'
      };
    },
  
    'skill:list': async (request) => {
      const { playerId, services } = request;
      const ownedSkills = await skillSystem.getPlayerSkills(playerId, services);
      if (ownedSkills.length === 0) {
        return { status: 'empty', data: {}, templateKey: 'skill:list.empty' };
      }
  
      const skillItems = [];
      for (const name of ownedSkills) {
        const def = await skillSystem.getSkillDefinition(name);
        skillItems.push(`${name}：${def ? def.description : '未知技能'}`);
      }
  
      return {
        status: 'success',
        data: {
          技能列表: skillItems.join('\n')
        },
        templateKey: 'skill:list.view'
      };
    }
  };

  core.registerModule('skill', { doors, templates, handlers });

  // 6. 监听玩家注册，赋予初始技能
  core.on('player:created', async (playerId, playerData) => {

  // 默认赋予“重击”技能
  // This event listener needs access to services.player.modify
  // Assuming core.services will be available here, or a separate service provider.
  // For now, passing core.services which should be initialized.
  if (core.services && core.services.player) {
    await skillSystem.addSkillToPlayer(playerId, '重击', core.services, { ensureAfterRegister: true });
    } else {
      core.log('warn', '无法在 player:created 事件中获取 core.services.player，未能赋予初始技能。');
    }
  });

  // 7. 导出模块接口
  core.skills = skillSystem;
  core.log('info', '技能模块加载完成。已注册逻辑处理器 skill:query, skill:list。');

  core.registerDataSource('技能', {
    description: '技能定义表',
    fields: ['名称','类型','描述','消耗'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM skills WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','类型':'type','描述':'description','消耗':'cost' };
      return row[map[字段]];
    }
  });

  return {
    moduleName: 'skill',
    ...skillSystem
  };
}

skillModule.moduleName = 'skill';
skillModule.dependencies = ['database', 'player'];

module.exports = skillModule;