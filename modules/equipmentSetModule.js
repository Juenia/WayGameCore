/**
 * 装备套装核心模块 - 处理套装识别、层级激活、效果应用与消息推送
 */
async function equipmentSetModule(core) {
  core.log('info', '正在加载装备套装核心模块...');

  /**
   * 按玩家的「套装检查」队列（2026-09-20）
   * ------------------------------------------------------------------
   * 装备/卸下是事件驱动的（下面那两个 core.on），快速连穿三件会**并发**跑三次检查，
   * 而每次都用自己读到的旧 _activeSetTiers 去算 diff → 三次都算成「新激活 3 件套」
   * → 加成叠三遍。以前是靠 player.modify 的「丢更新」掩盖着（只有最后一次生效，结果恰好对），
   * 把丢更新修掉之后立刻露出来 —— test_full 的「套装属性生效 (+50 生命上限)」当场变红。
   * 同一个玩家的检查串行即可：后一次能读到前一次写好的 _activeSetTiers，diff 才是对的。
   * （不用去借 player.modify 那把锁：那把锁在 modify 内部还会再取一次，包在外面会自锁。）
   */
  const setCheckQueues = new Map();
  function withSetCheckLock(playerId, task) {
    if (!playerId) return Promise.resolve().then(task);
    const prev = setCheckQueues.get(playerId) || Promise.resolve();
    const next = prev.then(task, task);
    const settled = next.catch(() => {});
    setCheckQueues.set(playerId, settled);
    settled.then(() => { if (setCheckQueues.get(playerId) === settled) setCheckQueues.delete(playerId); });
    return next;
  }

  const equipmentSetSystem = {
    /**
     * 初始化套装定义
     */
    init: async () => {
      // 监听装备变更事件
      core.on('equipment:equipped', async (playerId, equipmentName, slotId) => {
        await equipmentSetSystem.checkAndApplySetEffects(playerId, core, core.services);
      });

      core.on('equipment:unequipped', async (playerId, equipmentName, slotId) => {
        await equipmentSetSystem.checkAndApplySetEffects(playerId, core, core.services);
      });
      
      core.log('info', '装备套装模块初始化完成，已监听装备变更事件。');
    },

    /**
     * 获取所有套装定义 (合并数据库与内存)
     */
    getAllDefinitions: async () => {
      const dbSets = await core.db.getAllEquipmentSets();
      const memSets = Object.values(core.state.setDefinitions || {});
      
      // 合并，数据库优先
      const allSetsMap = new Map();
      memSets.forEach(s => allSetsMap.set(s.name, s));
      dbSets.forEach(s => allSetsMap.set(s.name, s));
      
      return Array.from(allSetsMap.values());
    },

    /**
     * 检查并应用套装效果
     * @param {string} playerId 玩家 ID
     */
    checkAndApplySetEffects: async (playerId, core, services) =>
      withSetCheckLock(playerId, () => equipmentSetSystem._applySetEffectsUnlocked(playerId, core, services)),

    /** 真正干活的实现（由上面的 checkAndApplySetEffects 串行调用，说明见文件顶部的队列注释） */
    _applySetEffectsUnlocked: async (playerId, core, services) => {
      const player = await services.player.get(playerId);
      if (!player) return;

      // 1. 获取玩家当前穿戴的所有装备名
      const equippedItems = Object.values(player.装备栏 || {}).filter(name => !!name);
      
      // 2. 获取所有套装配置
      const allSets = await equipmentSetSystem.getAllDefinitions();
      
      // 记录当前激活的套装效果，用于之后比对变化
      if (!player._activeSetTiers) player._activeSetTiers = {}; // setName -> maxTierIndex
      const oldActiveTiers = JSON.parse(JSON.stringify(player._activeSetTiers));
      const newActiveTiers = {};

      // 3. 遍历套装，计算达成情况
      for (const setDef of allSets) {
        // 计算玩家拥有的组件数量
        const count = setDef.components.filter(itemName => equippedItems.includes(itemName)).length;
        
        if (count > 0) {
          // 检查达成的层级
          const tiers = setDef.effects.tiers || [];
          // 找出所有达成的层级
          const reachedTierIndices = [];
          tiers.forEach((tier, index) => {
            if (count >= tier.requiredCount) {
              reachedTierIndices.push(index);
            }
          });

          if (reachedTierIndices.length > 0) {
            newActiveTiers[setDef.name] = reachedTierIndices;
          }
        }
      }

      // 4. 处理变更：移除失效的，应用新增的
      // 这里为了简单，我们采用“全量还原再全量应用”的策略，或者精确比对
      // 精确比对更安全，避免属性被多次扣除
      
      // 累积所有需要写库的变更
      const totalChanges = {};
      const _merge = (src) => {
        for (const k in src) {
          const v = src[k];
          if (typeof v === 'number') totalChanges[k] = (totalChanges[k] || 0) + v;
          else totalChanges[k] = v;
        }
      };

      // 找出需要移除的层级
      for (const setName in oldActiveTiers) {
        const oldIndices = oldActiveTiers[setName];
        const newIndices = newActiveTiers[setName] || [];
        
        for (const idx of oldIndices) {
          if (!newIndices.includes(idx)) {
            // 移除该层级效果
            const setDef = allSets.find(s => s.name === setName);
            if (setDef && setDef.effects.tiers[idx]) {
              _merge(equipmentSetSystem._applyTierEffect(player, setDef.effects.tiers[idx], -1, setDef.name, core, services));
            }
          }
        }
      }

      // 找出需要新增的层级
      for (const setName in newActiveTiers) {
        const newIndices = newActiveTiers[setName];
        const oldIndices = oldActiveTiers[setName] || [];
        
        for (const idx of newIndices) {
          if (!oldIndices.includes(idx)) {
            // 应用该层级效果
            const setDef = allSets.find(s => s.name === setName);
            if (setDef) {
              const tier = setDef.effects.tiers[idx];
              _merge(equipmentSetSystem._applyTierEffect(player, tier, 1, setDef.name, core, services));
              
              // 消息推送
              if (tier.push_message_enabled && (tier.push_message_text || tier.push_message_template)) {
                const _txt = tier.push_message_text || '🌟 【{套装名}】{件数}件套激活！';
                const _content = _txt
                  .replace(/{套装名}/g, setDef.name)
                  .replace(/{件数}/g, tier.requiredCount);
                core.push({
                  type: 'player',
                  id: playerId,
                  msg_type: 'markdown',
                  content: _content,
                  dedupe_key: `set_${setDef.name}_${tier.requiredCount}`,
                  dedupe_window: 300
                }).catch(e => core.log('warn', '[set] push 失败: ' + e.message));
              }
            }
          }
        }
      }

      // 更新玩家状态（含属性变更 + 激活层级记录）
      totalChanges._activeSetTiers = newActiveTiers;
      await services.player.modify({ playerId, changes: totalChanges, source: 'equipmentSet:apply_effects' });
    },

    /**
     * 查询玩家当前激活的套装信息（供其他模块调用）
     * @returns {Array<{ setName, count, total, maxTier, tierDescs: string[] }>}
     */
    getPlayerActiveSets: async (playerId, services) => {
      const player = await services.player.get(playerId);
      if (!player) return [];
      const equippedItems = Object.values(player.装备栏 || {}).filter(name => !!name);
      const allSets = await equipmentSetSystem.getAllDefinitions();
      const result = [];
      for (const setDef of allSets) {
        if (!Array.isArray(setDef.components)) continue;
        const count = setDef.components.filter(n => equippedItems.includes(n)).length;
        if (count === 0) continue;
        const tiers = (setDef.effects && setDef.effects.tiers) || [];
        const reachedTiers = tiers.filter(t => count >= t.requiredCount);
        if (reachedTiers.length === 0) continue;
        const tierDescs = reachedTiers.map(t => {
          const parts = (t.effects || []).map(e => {
            if (e.type === 'attribute') return `${e.attr}+${e.value}`;
            return JSON.stringify(e);
          });
          return `  • ${t.requiredCount}件套：${parts.join(' ')}`;
        });
        result.push({
          setName: setDef.name,
          count,
          total: setDef.components.length,
          maxTier: reachedTiers.length,
          tierDescs
        });
      }
      return result;
    },

    /**
     * 获取玩家所有有装备的套装快照（含未激活层级的）
     * 供卸下/装备时做前后对比
     */
    getSetSnapshot: async (playerId, services) => {
      const player = await services.player.get(playerId);
      if (!player) return [];
      const equippedItems = Object.values(player.装备栏 || {}).filter(name => !!name);
      const allSets = await equipmentSetSystem.getAllDefinitions();
      const result = [];
      for (const setDef of allSets) {
        if (!Array.isArray(setDef.components)) continue;
        const count = setDef.components.filter(n => equippedItems.includes(n)).length;
        if (count === 0) continue;
        const tiers = (setDef.effects && setDef.effects.tiers) || [];
        const reachedTiers = tiers.filter(t => count >= t.requiredCount);
        result.push({
          setName: setDef.name,
          count,
          total: setDef.components.length,
          activeTiers: reachedTiers.map(t => t.requiredCount),
          tierDescs: reachedTiers.map(t => {
            const parts = (t.effects || []).map(e => {
              if (e.type === 'attribute') return `${e.attr}+${e.value}`;
              return JSON.stringify(e);
            });
            return `  • ${t.requiredCount}件套：${parts.join(' ')}`;
          })
        });
      }
      return result;
    },

    /**
     * 应用或移除单个层级的效果
     * @param {Object} player 玩家对象
     * @param {Object} tier 层级定义
     * @param {number} multiplier 1 为应用，-1 为移除
     * @param {string} setName 套装名称
     */
    _applyTierEffect: (player, tier, multiplier, setName, core, services) => {
      if (!tier.effects) return {};
      const playerChanges = {};
      for (const effect of tier.effects) {
        switch (effect.type) {
          case 'attribute':
            // 修改属性
            const attr = effect.attr;
            const val = effect.value * multiplier;
            playerChanges[attr] = (playerChanges[attr] || 0) + val;
            
            // 同步增加上限属性
            if (attr === '生命') {
              playerChanges.生命上限 = (playerChanges.生命上限 || 0) + val;
            } else if (attr === '魔法') {
              playerChanges.魔法上限 = (playerChanges.魔法上限 || 0) + val;
            }
            break;
            
          case 'exp_multiplier':
            // 经验倍率 (累加倍率，如 0.5 表示 +50%)
            playerChanges._expMultiplierBonus = (playerChanges._expMultiplierBonus || 0) + (effect.value * multiplier);
            break;

          case 'currency_multiplier':
            // 货币倍率 (按货币 ID 存储累加倍率)
            if (!playerChanges._currencyMultiplierBonuses) playerChanges._currencyMultiplierBonuses = {};
            const cid = effect.currency_id || 1;
            playerChanges._currencyMultiplierBonuses[cid] = (playerChanges._currencyMultiplierBonuses[cid] || 0) + (effect.value * multiplier);
            break;

          case 'passive_skill':
          case 'active_skill':
            // 技能增减
            // This part is tricky. We need to modify player.技能栏 based on current state.
            // For simplicity, let's assume services.player.modify can handle array modifications or we fetch the current player.
            // For now, let's assume player object passed here is mutable and directly modify it.
            // A better way would be to get current player, modify, then pass to services.player.modify
            // But since the current pattern is to pass `player` and modify it, I'll stick to that.
            if (!Array.isArray(player.技能)) player.技能 = [];
            if (multiplier === 1) {
              if (!player.技能.includes(effect.skill_id)) {
                player.技能.push(effect.skill_id);
              }
            } else {
              player.技能 = player.技能.filter(s => s !== effect.skill_id);
            }
            playerChanges.技能 = player.技能;
            break;
        }
      }
      return playerChanges;
    }
  };

  core.registerModule('equipmentSet', {
    doors: [
      { default_triggers: ['套装', '查看套装信息'], logical_name: 'equipmentSet:view', description: '查看套装详细信息' }
    ],
    templates: {
      'equipmentSet:view.fail_missing_set_name': { text: '请指定要查看的套装名。', markdown: '请指定要查看的套装名。' },
      'equipmentSet:view.fail_not_found': { text: '套装 {套装名} 不存在。', markdown: '套装 **{套装名}** 不存在。' },
      'equipmentSet:view.success': { text: '【{套装名}】\n描述：{套装描述}\n组件：{套装组件}\n效果：\n{套装效果}', markdown: '【**{套装名}**】\n描述：{套装描述}\n组件：{套装组件}\n效果：\n{套装效果}' }
    },
    handlers: {
      'equipmentSet:view': async (request) => {
        const { playerId, args, core, services } = request;
        const setName = args[0];
        if (!setName) return { status: 'fail_missing_set_name', content: '请指定要查看的套装名。' };
    
        const allSets = await equipmentSetSystem.getAllDefinitions();
        const setDef = allSets.find(s => s.name === setName);
        
        if (!setDef) {
          return { status: 'fail_not_found', data: { 套装名: setName }, templateKey: 'equipmentSet:view.fail_not_found' };
        }
    
        return {
          status: 'success',
          data: {
            套装名: setName, 
            套装描述: setDef.description || '无描述',
            套装组件: setDef.components.join(', '),
            套装效果: JSON.stringify(setDef.effects),
            name: setName, 
            ...setDef 
          },
          templateKey: 'equipmentSet:view.success'
        };
      }
    }
  });

  // 执行初始化
  await equipmentSetSystem.init();

  core.equipmentSets = equipmentSetSystem;
  
  return {
    moduleName: 'equipmentSet',
    ...equipmentSetSystem
  };
}

equipmentSetModule.moduleName = 'equipmentSet';
equipmentSetModule.dependencies = ['database', 'player', 'equipment'];

module.exports = equipmentSetModule;
