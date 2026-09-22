/**
 * 战斗系统模块 - 处理回合制战斗、怪物行为、掉落、经验与等级联动
 */
async function combatModule(core) {
  core.log('info', '正在加载战斗系统模块...');

  // 1. 初始化核心状态
  if (!core.state.combat) core.state.combat = {};
  if (!core.state.monsterInstances) core.state.monsterInstances = {};
  if (!core.state.monsters) core.state.monsters = {};

  // 2. 怪物稀有度倍率
  const rarityMultipliers = {
    '普通': 1.0,
    '稀有': 1.5,
    '精英': 2.5,
    'BOSS': 5.0
  };

  // 3. 默认怪物数据
  const { worldSeed } = require('./world/load.js');

  const defaultMonsters = {
    '史莱姆': {
      name: '史莱姆',
      category: '普通',
      level: 1,
      description: '绿色的粘液生物，非常弱小。',
      stats: { 生命: 30, 魔法: 0, 攻击: 5, 防御: 2, 暴击率: 0, 暴击伤害: 100, 闪避率: 0 },
      skills: [],
      drops: [{ type: 'item', name: '史莱姆粘液', chance: 0.5, quantity: 1 }],
      expReward: 10,
      aggressive: false,
      aggressiveChance: 0,
      enrage: { enabled: false, hpThreshold: 30, multiplier: 1.5 },
      flee: { enabled: true, hpThreshold: 20, chance: 0.3 },
      respawnTime: 10,
      killGrowth: { enabled: false, statIncrease: { 攻击: 1, 防御: 1 }, maxGrowthCount: 5 }
    },
    '野狼': {
      name: '野狼',
      category: '普通',
      level: 1,
      description: '一只饥饿的野狼',
      stats: { 生命: 50, 魔法: 10, 攻击: 8, 防御: 2, 暴击率: 5, 暴击伤害: 150, 闪避率: 5 },
      skills: [{ name: '撕咬', type: 'damage', multiplier: 1.2, chance: 0.6, description: '用利齿撕咬敌人' }],
      drops: [{ type: 'item', name: '木材', chance: 0.5, quantity: 1 }, { type: 'currency', currencyType: 1, chance: 0.3, amount: 10 }],
      expReward: 20,
      aggressive: false,
      aggressiveChance: 0,
      enrage: { enabled: false, hpThreshold: 30, multiplier: 1.5 },
      flee: { enabled: true, hpThreshold: 20, chance: 0.5 },
      respawnTime: 30,
      killGrowth: { enabled: true, statIncrease: { 攻击: 2, 防御: 1 }, maxGrowthCount: 10 }
    }
  };

  // 初始化怪物定义
  // ── 世界种子合并（2026-09-19）──────────────────────────────────────────────
  // modules/world/monsters.json 是从当前正式世界（data/game.db）导出的内容种子，是唯一真源；
  // 内置的三只小怪只在种子文件缺失/为空时兜底。已有库完全不受影响。
  const worldMonsters = worldSeed('monsters', Object.values(defaultMonsters));
  const seedMonsters = Object.fromEntries(worldMonsters.map((m) => [m.name, m]));
  const dbMonsters = await core.db.getAllMonsters();
  if (dbMonsters.length === 0) {
    core.log('info', `数据库怪物表为空，正在写入世界种子怪物数据（${worldMonsters.length} 只）...`);
    for (const [name, def] of Object.entries(seedMonsters)) {
      await core.db.saveMonster(name, def);
    }
  }

  // 同步内存状态
  const allMonsters = await core.db.getAllMonsters();
  allMonsters.forEach(m => {
    core.state.monsters[m.name] = m;
  });
  core.log('info', `从数据库加载了 ${allMonsters.length} 个怪物定义。`);

  // 4. 辅助方法
  const combatSystem = {
    getMonsterDefinition: (name) => core.state.monsters[name] || null,

    createMonsterInstance: (monsterName, location) => {
      const def = combatSystem.getMonsterDefinition(monsterName);
      if (!def) return null;

      const instanceId = `monster_${monsterName}_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      
      // 应用稀有度倍率 (如果 stats 没有被标记为已缩放，则按分类缩放)
      const multiplier = rarityMultipliers[def.category] || 1.0;
      const stats = { ...def.stats };
      
      // 只有当不是默认预设怪物时，才根据倍率缩放属性
      // 这里我们假设默认怪物的 stats 已经是最终值，不再缩放
      // 如果需要更通用的逻辑，可以在 def 中增加 scaled: true 标志
      
      const instance = {
        instanceId,
        definitionName: monsterName,
        currentHp: stats.生命,
        max生命: stats.生命,
        stats: stats,
        enraged: false,
        growthCount: 0,
        status: 'idle',
        location: location || '未知',
        homeLocation: location || '未知',
        fleeTarget: null,
        attackers: [],   // 参与战斗的 playerId 数组
        aggro: {}        // { playerId: 累计伤害 }
      };

      core.state.monsterInstances[instanceId] = instance;
      return instance;
    },

    getMonsterInstance: (instanceId) => core.state.monsterInstances[instanceId] || null,

    /**
     * 伤害计算核心公式
     */
    calculateDamage: (attackerStats, defenderStats, isSkill = false, skillMultiplier = 1.0) => {
      const atk = attackerStats.攻击;
      const def = defenderStats.防御;
      
      // 1. 基础伤害
      let baseDamage = isSkill ? (atk * skillMultiplier - def) : (atk - def);
      if (baseDamage < 1) baseDamage = 1;

      // 2. 闪避判定
      const dodgeRate = defenderStats.闪避率 || 0;
      if (Math.random() * 100 < dodgeRate) {
        return { damage: 0, dodged: true };
      }

      // 3. 暴击判定
      const critRate = attackerStats.暴击率 || 0;
      const critDmg = attackerStats.暴击伤害 || 100;
      let isCrit = false;
      let damage = baseDamage;

      if (Math.random() * 100 < critRate) {
        isCrit = true;
        damage = baseDamage * (critDmg / 100);
      }

      // 4. 伤害浮动 (默认 0.9 - 1.1)
      const floatMin = core.config.combat?.damageFloatMin || 0.9;
      const floatMax = core.config.combat?.damageFloatMax || 1.1;
      const float = floatMin + Math.random() * (floatMax - floatMin);
      damage = Math.round(damage * float);

      return { damage, isCrit, dodged: false };
    },

    /**
     * 执行战斗回合
     */
    executeRound: async (playerId, action = { type: 'attack' }, services) => {
      const combat = core.state.combat[playerId];
      if (!combat || combat.status !== 'active') return { success: false, message: '不在战斗状态。' };

      const basePlayer = core.state.players[playerId];
      const monster = core.state.monsterInstances[combat.lockedMonsterId];

      if (!monster || monster.status === 'dead' || monster.status === 'fleeing') {
        delete core.state.combat[playerId];
        return { success: false, message: '目标已消失。' };
      }

      // 获取包含被动技能加成的有效属性
      const skillMod = core.getModule('skill');
      const passiveBonuses = skillMod ? await skillMod.getPassiveBonuses(playerId) : {};
      const player = { ...basePlayer };
      for (const [attr, val] of Object.entries(passiveBonuses)) {
        player[attr] = (player[attr] || 0) + val;
      }

      
      // --- 0. apply persistent buffs (player_buffs) ---
      // 2026-09-22：倍率另记一份，供怪物回合后重建视图用（见下面「怪物回合后同步真身」）
      const buffMults = {};
      try {
        const now = Date.now();
        const buffs = await core.db.playerDb.all('SELECT buff_name, multiplier, expires_at FROM player_buffs WHERE player_id = ?', [playerId]);
        for (const b of buffs) {
          if (b.expires_at && b.expires_at <= now) {
            // 过期 buff：顺手清理，避免堆积
            try { await core.db.playerDb.run('DELETE FROM player_buffs WHERE player_id = ? AND buff_name = ?', [playerId, b.buff_name]); } catch (_) {}
            continue;
          }
          const mult = Number(b.multiplier) || 1;
          if (mult === 1) continue;
          const attr = String(b.buff_name).split('*')[0];
          if (player[attr] != null) player[attr] = Math.round(player[attr] * mult);
          buffMults[attr] = (buffMults[attr] || 1) * mult;
        }
      } catch (e) {}

      let log = [];
      let playerTurnResult = null;

      // --- 1. 玩家回合 ---
      if (action.type === 'attack') {
        playerTurnResult = combatSystem.calculateDamage(player, monster.stats);
        if (playerTurnResult.dodged) {
          log.push(`你对 [怪物名] 发起攻击，但是被怪物闪避了！`);
        } else {
          monster.currentHp -= playerTurnResult.damage;
          log.push(`你对 [怪物名] 造成了 ${playerTurnResult.damage} 点伤害${playerTurnResult.isCrit ? ' (暴击!)' : ''}。`);
        }
      } else if (action.type === 'skill') {
        const skill = action.skill;
        playerTurnResult = combatSystem.calculateDamage(player, monster.stats, true, skill.multiplier || 1.0);
        if (playerTurnResult.dodged) {
          log.push(`你使用了 [技能名]，但是被 [怪物名] 闪避了！`);
        } else {
          const totalDamage = playerTurnResult.damage + (skill.bonusDamage || 0);
          monster.currentHp -= totalDamage;
          log.push(`你使用了 [技能名]，对 [怪物名] 造成了 ${totalDamage} 点伤害${playerTurnResult.isCrit ? ' (暴击!)' : ''}。`);
        }
        // 处理技能冷却
        if (skill.name) {
          combat.skillCooldowns[skill.name] = (skill.cooldown || 3);
        }
      } else if (action.type === 'none' && action.message) {
        log.push(action.message);
      }

      // 检查怪物是否触发狂暴
      const monsterDef = combatSystem.getMonsterDefinition(monster.definitionName);
      if (monsterDef.enrage?.enabled && !monster.enraged) {
        const hpPercent = (monster.currentHp / monster.max生命) * 100;
        if (hpPercent <= monsterDef.enrage.hpThreshold) {
          monster.enraged = true;
          const mult = monsterDef.enrage.multiplier;
          Object.keys(monster.stats).forEach(key => {
            // 排除生命/魔法及其上限，狂暴只提升攻防等战斗属性
            if (['生命', '生命上限', '魔法', '魔法上限'].includes(key)) return;
            monster.stats[key] *= mult;
          });
          log.push(`[怪物名] 狂暴化了！属性大幅提升！`);
          await core.emit('monster:enraged', monster.instanceId, monster.definitionName, mult);
        }
      }

      // 检查怪物是否死亡
      if (monster.currentHp <= 0) {
        monster.currentHp = 0;
        monster.status = 'dead';
        const victoryRes = await combatSystem._handleVictory(playerId, monster, services);
        log.push(victoryRes.message);
        
        const finalMessage = await core.renderTemplate(log.join('\n'), {
          player,
          monster,
          monsterInstance: monster,
          怪物名: monster.definitionName,
          技能名: action.skill?.name
        }, { escape: true }, playerId);
        
        return { success: true, message: String(finalMessage), finished: true };
      }

      // --- 2. 怪物回合 ---
      const monsterTurnResult = await combatSystem._executeMonsterTurn(playerId, monster, services);
      log.push(monsterTurnResult.message);

      // ── 2026-09-22 修复：怪物回合后把「视图副本」拉回真身 ──────────────────────
      // 上面第 174 行的 player 只是回合开始时的浅拷贝；怪物反击扣血、上 debuff 改的是
      // core.state.players[playerId] 这个真身。不同步的话，下面【战斗状态】和 combat:round
      // 事件报的都是「挨打前」的血量 —— 角色面板已经扣了、战斗状态栏却没扣。
      // 同步完再按同一套口径补回被动加成与常驻 buff，保持渲染值与战斗计算一致。
      const livePlayer = core.state.players[playerId];
      if (livePlayer) {
        for (const key of Object.keys(player)) {
          if (key in livePlayer) player[key] = livePlayer[key];
        }
        for (const [attr, val] of Object.entries(passiveBonuses)) {
          player[attr] = (player[attr] || 0) + val;
        }
        for (const [attr, mult] of Object.entries(buffMults)) {
          if (player[attr] != null) player[attr] = Math.round(player[attr] * mult);
        }
      }

      
      if (monsterTurnResult.finished) {
        const finalMessage = await core.renderTemplate(log.join('\n'), {
          player,
          monster,
          monsterInstance: monster,
          怪物名: monster.definitionName,
          技能名: action.skill?.name
        }, { escape: true }, playerId);
        return { success: true, message: String(finalMessage), finished: true };
      }

      // 回合结束
      combat.turn += 1;
      // 减少技能冷却
      Object.keys(combat.skillCooldowns).forEach(s => {
        if (combat.skillCooldowns[s] > 0) combat.skillCooldowns[s] -= 1;
      });

      await core.emit('combat:round', playerId, monster.definitionName, combat.turn, player.生命, monster.currentHp);
      
      const statusTemplate = await core.db.getMessageTemplate('combat.status.compact') ||
        `
【战斗状态】 你的生命: {player.生命}/{player.生命上限} | 怪物生命: {monster.currentHp}/{monster.max生命}`;
      const statusMsg = await core.renderTemplate(statusTemplate, { player, monster }, { escape: false }, playerId);
      log.push(String(statusMsg));

      // 渲染最终日志
      const logContent = log.join('\n');
      const finalMessage = await core.renderTemplate(logContent, {
        player,
        monster,
        monsterInstance: monster,
        怪物名: monster.definitionName,
        技能名: action.skill?.name
      }, { escape: true }, playerId);

      return { success: true, message: String(finalMessage), finished: false };
    },

    /**
     * 执行怪物回合逻辑 (含逃跑判定与行动)
     */
    _executeMonsterTurn: async (playerId, monster, services) => {
      const combat = core.state.combat[playerId];
      const basePlayer = core.state.players[playerId];
      
      // 获取有效属性 (含被动加成)
      const skillMod = core.getModule('skill');
      const passiveBonuses = skillMod ? await skillMod.getPassiveBonuses(playerId) : {};
      const player = { ...basePlayer };
      for (const [attr, val] of Object.entries(passiveBonuses)) {
        player[attr] = (player[attr] || 0) + val;
      }

      const monsterDef = combatSystem.getMonsterDefinition(monster.definitionName);
      let log = [];
       
      // 1. 检查怪物是否逃跑
      if (monsterDef.flee?.enabled) {
        const hpPercent = (monster.currentHp / monster.max生命) * 100;
        if (hpPercent <= monsterDef.flee.hpThreshold) {
          if (Math.random() < monsterDef.flee.chance) {
            const maps = core.state.world.maps;
            const currentMap = maps[monster.location];
            const connections = Object.values(currentMap.connections);
            if (connections.length > 0) {
              const toMap = connections[Math.floor(Math.random() * connections.length)];
              const fromMap = monster.location;
              
              // 移动怪物
              const mapMod = core.getModule('map');
              await mapMod.removeMonsterFromMap(fromMap, monster.definitionName);
              await mapMod.addMonsterToMap(toMap, monster.definitionName);
              
              monster.location = toMap;
              monster.status = 'idle';
              
              await core.emit('monster:fled', monster.instanceId, monster.definitionName, fromMap, toMap);
              
              const fleeTemplate = await core.db.getMessageTemplate('combat.monster.flee') || "[怪物名]惊慌失措地逃向了 [目标地图] 的方向。";
              const fleeMsg = await core.renderTemplate(fleeTemplate, {
                monster: monster,
                怪物名: monster.definitionName, // 显式传递以确保变量解析成功
                目标地图: toMap,
                fromMap: fromMap
              }, { escape: true }, playerId);
              
              delete core.state.combat[playerId];
              return { finished: true, message: String(fleeMsg) };
            }
          }
        }
      }

      // 2. 怪物行动
      let monsterAction = { type: 'attack' };
      if (monsterDef.skills && monsterDef.skills.length > 0) {
        // 随机选择一个技能尝试释放
        const skill = monsterDef.skills[Math.floor(Math.random() * monsterDef.skills.length)];
        if (Math.random() < skill.chance) {
          monsterAction = { type: 'skill', skill };
        }
      }

      let monsterRes = null;
      if (monsterAction.type === 'attack') {
        monsterRes = combatSystem.calculateDamage(monster.stats, player);
        if (monsterRes.dodged) {
          const dodgeTemplate = await core.db.getMessageTemplate('combat.player_dodged') || "你敏捷地闪避了 [怪物名] 的攻击！";
          log.push(await core.renderTemplate(dodgeTemplate, { monster: monster, 怪物名: monster.definitionName }, { escape: true }, playerId));
        } else {
          basePlayer.生命 -= monsterRes.damage;
          player.生命 = basePlayer.生命; // 同步给副本用于后续逻辑
          const attackMsg = await core.renderTemplate(`[怪物名] 对你造成了 ${monsterRes.damage} 点伤害${monsterRes.isCrit ? ' (暴击!)' : ''}。`, { monster: monster, 怪物名: monster.definitionName }, { escape: true }, playerId);
          log.push(attackMsg);
        }
      } else {
        const skill = monsterAction.skill;
        if (skill.type === 'damage') {
          monsterRes = combatSystem.calculateDamage(monster.stats, player, true, skill.multiplier);
          if (monsterRes.dodged) {
            const dodgeTemplate = await core.db.getMessageTemplate('combat.player_dodged') || "你闪避了 [怪物名] 的 [技能名]！";
            log.push(await core.renderTemplate(dodgeTemplate, { monster: monster, 怪物名: monster.definitionName, 技能名: skill.name }, { escape: true }, playerId));
          } else {
            basePlayer.生命 -= monsterRes.damage;
            player.生命 = basePlayer.生命; // 同步给副本
            const skillMsg = await core.renderTemplate(`[怪物名] 使用了 [技能名]，对你造成了 ${monsterRes.damage} 点伤害${monsterRes.isCrit ? ' (暴击!)' : ''}。`, { monster: monster, 怪物名: monster.definitionName, 技能名: skill.name }, { escape: true }, playerId);
            log.push(skillMsg);
          }
        } else if (skill.type === 'debuff') {
          const val = skill.value || 0;
          basePlayer[skill.target] = Math.max(0, (basePlayer[skill.target] || 0) - val);
          player[skill.target] = basePlayer[skill.target]; // 同步给副本
          const debuffMsg = await core.renderTemplate(`[怪物名] 使用了 [技能名]，你的 ${skill.target} 降低了 ${val} 点。`, { monster: monster, 怪物名: monster.definitionName, 技能名: skill.name }, { escape: true }, playerId);
          log.push(debuffMsg);
        }
      }

      // 3. 检查玩家是否死亡
      if (basePlayer.生命 <= 0) {
        basePlayer.生命 = 0;
        const defeatRes = await combatSystem._handleDefeat(playerId, monster, services);
        return { finished: true, message: log.join('\n') + '\n' + defeatRes.message };
      }

      return { finished: false, message: log.join('\n') };
    },

      
    _handleVictory: async (playerId, monster, services) => {
      const player = core.state.players[playerId];
      const monsterDef = combatSystem.getMonsterDefinition(monster.definitionName);

      // 战斗v2：计算参战者伤害占比
      const _attackerIds = (monster.attackers && monster.attackers.length) ? monster.attackers : [playerId];
      const _totalAggro = _attackerIds.reduce((sum, pid) => sum + (monster.aggro[pid] || 0), 0);
      const _shareMap = {};
      for (const pid of _attackerIds) {
        _shareMap[pid] = _totalAggro > 0 ? ((monster.aggro[pid] || 0) / _totalAggro) : (1 / _attackerIds.length);
      }

      const drops = [];
      const backpack = core.getModule('backpack');
      for (const _pid of _attackerIds) {
        const _p = core.state.players[_pid];
        if (!_p) continue;
        for (const drop of (monsterDef.drops || [])) {
          if (Math.random() >= drop.chance) continue;
          if (drop.type === 'currency') {
           const currencyType = drop.currencyType || 1;
           const field = { 1: '金币', 2: '银币', 3: '铜币' }[currencyType];
           const bonus = _p._currencyMultiplierBonuses ? (_p._currencyMultiplierBonuses[currencyType] || 0) : 0;
           const amount = Math.floor(drop.amount * (1 + bonus));
           await services.player.giveCurrency({ targets: [_pid], field, amount, source: 'combat:reward' });
           if (_pid === playerId) drops.push(field + ' x' + amount + (bonus > 0 ? ' (+' + Math.round(bonus * 100) + '%)' : ''));
          } else {
           await backpack.addItem(_pid, drop.name, drop.quantity);
           if (_pid === playerId) drops.push(drop.name + ' x' + drop.quantity);
          }
        }
      }

      // 2. 经验奖励（战斗v2：按伤害占比分给每个参战者）
      const _baseExp = monsterDef.expReward || 0;
      let levelUpMsg = '';
      let exp = 0; // 主视角玩家获得的经验（用于消息渲染）
      const expPerLevel = core.config.combat?.expPerLevel || 100;
      for (const _pid of _attackerIds) {
        const _p = core.state.players[_pid];
        if (!_p) continue;
        let gainExp = Math.floor(_baseExp * (_shareMap[_pid] || 0));
        const expBonus = _p._expMultiplierBonus || 0;
        if (expBonus > 0) gainExp += Math.floor(gainExp * expBonus);
        if (_pid === playerId) exp = gainExp; // 记录主视角玩家经验
        _p.经验 = (_p.经验 || 0) + gainExp;
        while (_p.经验 >= _p.等级 * expPerLevel) {
          _p.经验 -= _p.等级 * expPerLevel;
          const oldLv = _p.等级;
          _p.等级 += 1;
          _p.生命 = _p.生命上限;
          if (_pid === playerId) levelUpMsg += String.fromCharCode(10)+'恭喜！你升级了！当前等级: ' + _p.等级;
          await core.emit('player:level_up', _pid, oldLv, _p.等级);
        }
      }

      // 3. 扫尾与移除实例
      const instanceId = monster.instanceId;
      const monsterName = monster.definitionName;
      const homeLocation = monster.homeLocation;
      const currentLocation = monster.location;
      
      // 从当前地图移除该怪物名称 (用于停止在该地图生成该实例的逻辑)
      const mapMod = core.getModule('map');
      if (mapMod) {
        await mapMod.removeMonsterFromMap(currentLocation, monsterName);
      }
      
      // 删除实例
      // 战斗v2：清理所有参战者的 combat 状态
 const _attackers = monster.attackers || [];
 for (const _pid of _attackers) { delete core.state.combat[_pid]; }
 delete core.state.combat[playerId];
 delete core.state.monsterInstances[instanceId];
      
      // 4. 设置重生逻辑
      const respawnTime = (monsterDef.respawnTime || 30) * 1000;
      setTimeout(async () => {
        core.log('info', `怪物 [${monsterName}] 正在从 [${homeLocation}] 重生...`);
        if (mapMod) {
          await mapMod.addMonsterToMap(homeLocation, monsterName);
        }
        await core.emit('monster:respawned', monsterName, homeLocation);
      }, respawnTime);

      const changes = {};
      if (player.经验 !== undefined) changes.经验 = { set: player.经验 };
      if (player.等级 !== undefined) changes.等级 = { set: player.等级 };
      if (player.生命 !== undefined) changes.生命 = { set: player.生命 };
      if (Object.keys(changes).length > 0) {
        await core.services.player.modify({
          playerId,
          changes,
          source: 'combat:victory'
        });
      }
      
      await core.emit('combat:victory', playerId, monsterName, exp, drops);
      await core.emit('enemy:killed', playerId, monsterName, exp, drops);
      
      const victoryTemplate = await core.db.getMessageTemplate('combat.monster.dead') ||
        `战斗胜利！你击败了 [怪物名]。
获得了经验: [怪物经验奖励]`

      const message = await core.renderTemplate(victoryTemplate, {
        monster,
        monsterInstance: monster,
        怪物名: monster.definitionName,
        exp,
        怪物经验奖励: exp,
        drops,
        levelUpMsg
      }, { escape: true }, playerId);

      return { message };
    },

    _handleDefeat: async (playerId, monster, services) => {
      const player = core.state.players[playerId];
      const monsterDef = combatSystem.getMonsterDefinition(monster.definitionName);

      // 1. 怪物成长
      if (monsterDef.killGrowth?.enabled && monster.growthCount < monsterDef.killGrowth.maxGrowthCount) {
        monster.growthCount += 1;
        const inc = monsterDef.killGrowth.statIncrease;
        Object.entries(inc).forEach(([k, v]) => {
          monster.stats[k] = (monster.stats[k] || 0) + v;
        });
        await core.emit('monster:grown', monster.instanceId, monster.definitionName, inc, monster.growthCount);
      }

      // 2. 玩家死亡处理
      const oldMap = player.当前地图;
      const newHp = player.生命上限;
      const mainCity = core.state.settings?.main_city || player.初始地图 || '新手村';
      const newMap = mainCity;

      monster.status = 'idle';
      delete core.state.combat[playerId];

      await core.services.player.modify({
        playerId,
        changes: {
          生命: { set: newHp },
          当前地图: { set: newMap }
        },
        source: 'combat:defeat'
      });

      // 让本地 player 对象反映最新值
      player.生命 = newHp;
      player.当前地图 = newMap;

      await core.emit('combat:defeat', playerId, monster.definitionName);
      await core.emit('player:died', playerId, monster.definitionName);
      await core.emit('player:moved', playerId, oldMap, player.当前地图);

      const defeatTemplate = await core.db.getMessageTemplate('combat.defeat') ||
        `战斗失败... 你被 [怪物名] 击败了。已经过村医救治，返回了 ${player.当前地图}。`;

      return {
        message: await core.renderTemplate(defeatTemplate, {
          monster,
        monsterInstance: monster,
        怪物名: monster.definitionName
      }, { escape: true }, playerId)
      };
    }
  };

  // 5. 注册模块
  const doors = [
    { logical_name: 'combat:attack', default_triggers: ['攻击', 'atk', 'attack'], description: '攻击当前地图的怪物' },
    { logical_name: 'combat:flee', default_triggers: ['逃跑', 'flee', 'run'], description: '尝试从战斗中逃跑' },
    { logical_name: 'combat:status', default_triggers: ['战斗状态', 'status', 'bs'], description: '查看当前战斗详细信息' },
    { logical_name: 'combat:view_monster', default_triggers: ['查看怪物'], description: '查看怪物详情' },
    { logical_name: 'skill:use', default_triggers: ['使用技能', 'skill'], description: '释放主动技能' }
  ];

  const templates = {
    'combat:already_locked': { text: '你正在与 [怪物名] 战斗中，无法分身攻击 {monsterName}。', markdown: '你正在与 **[怪物名]** 战斗中，无法分身攻击 **{monsterName}**。' },
    'combat:monster_not_in_map': { text: '当前地图没有 {monsterName}。', markdown: '当前地图没有 **{monsterName}**。' },
    'combat:view_monster.success': { text: '【[??名]】\n等级：{怪物等级}\n生命：{怪物生命}\n攻击：{怪物攻击}\n防御：{怪物防御}\n描述：{怪物描述}', markdown: '【**[怪物名]**】\n等级：{怪物等级}\n生命：{怪物生命}\n攻击：{怪物攻击}\n防御：{怪物防御}\n描述：{怪物描述}' },
    'combat:view_monster.not_found': { text: '怪物 [怪物名] 不存在。', markdown: '怪物 **[怪物名]** 不存在。' },
    'combat:start': { text: '你向 [怪物名] 发起了攻击！', markdown: '你向 **[怪物名]** 发起了攻击！' },
    'combat:monster.flee': { text: '[怪物名]惊慌失措地逃向了 [目标地图] 的方向。', markdown: '**[怪物名]** 惊慌失措地逃向了 **[目标地图]** 的方向。' },
    'combat:player_dodged': { text: '你敏捷地闪避了 [怪物名] 的攻击！', markdown: '你敏捷地闪避了 **[怪物名]** 的攻击！' },
    'combat:status.compact': { text: `\n【战斗状态】 你的生命: {player.生命}/{player.生命上限} | 怪物生命: {monster.currentHp}/{monster.max生命}`, markdown: `\n**【战斗状态】** 你的生命: {player.生命}/{player.生命上限} | 怪物生命: {monster.currentHp}/{monster.max生命}` },
    'combat:monster.dead': { text: `战斗胜利！你击败了 [怪物名]。\n获得了经验: [怪物经验奖励]`, markdown: `战斗胜利！你击败了 **[怪物名]**。\n获得了经验: **[怪物经验奖励]**` },
    'combat:defeat': { text: '战斗失败... 你被 [怪物名] 击败了。已经过村医救治，返回了 {player.当前地图}。', markdown: '战斗失败... 你被 **[怪物名]** 击败了。已经过村医救治，返回了 **{player.当前地图}**。' },
    'combat:aggressive_attack': { text: `[怪物名] 突然从暗处窜出主动攻击了你！\n[结果]`, markdown: `**[怪物名]** 突然从暗处窜出主动攻击了你！\n[结果]` },
    'combat:status.fail_not_in_combat': { text: '你当前不在战斗状态。', markdown: '你当前不在战斗状态。' },
    'combat:status': {
      text: `你正在与 [怪物名] 战斗！\n` +
            `怪物等级：{monster.level}\n` +
            `怪物分类：{monster.category}\n` +
            `怪物生命：{monster.currentHp}/{monster.max生命}\n` +
            `你的生命：{player.生命}/{player.生命上限}\n` +
            `当前回合：{combat.turn}\n` +
            `{monster.enraged ? 【怪物已狂暴化！】\n : }` +
            `{monster.growthCount > 0 ? 【怪物已成长 {monster.growthCount} 次】 : }`,

      markdown: `你正在与 **[怪物名]** 战斗！\n` +
            `怪物等级：{monster.level}\n` +
            `怪物分类：{monster.category}\n` +
            `怪物生命：{monster.currentHp}/{monster.max生命}\n` +
            `你的生命：{player.生命}/{player.生命上限}\n` +
            `当前回合：{combat.turn}\n` +
            `{monster.enraged ? **【怪物已狂暴化！】**\n : }` +
            `{monster.growthCount > 0 ? **【怪物已成长 {monster.growthCount} 次】** : }`
    }
  };

  const handlers = {
    'combat:attack': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const monsterName = args[0];
      const combat = core.state.combat[playerId];

      if (combat && combat.status === 'active') {
        if (!monsterName || monsterName === combat.monsterName) {
          const res = await combatSystem.executeRound(playerId, undefined, services); // Pass services
          return { status: res.success ? 'success' : 'fail', data: { message: res.message }, templateKey: res.success ? 'system.info' : 'system.error' };
        } else {
          const currentMonster = core.state.monsterInstances[combat.lockedMonsterId];
          return { status: 'fail_already_locked', data: { monsterName, monster: currentMonster, 怪物名: combat.monsterName }, templateKey: 'combat:already_locked' };
        }
      }

      if (!monsterName) return { status: 'fail_no_monster_specified', data: {}, templateKey: 'system.invalid_command_args' };

      // 检查地图怪物
      const mapMod = core.getModule('map');
      const map = mapMod.getPlayerMap(playerId);
      if (!map || !map.monsters.includes(monsterName)) {
        return { status: 'fail_monster_not_in_map', data: { monsterName }, templateKey: 'combat:monster_not_in_map' };
      }

      // 查找该地图是否已存在该怪物的实例 (支持血量持久化)
      // 逻辑优化：优先寻找当前玩家正在战斗的或者空闲的该名怪物实例
      let instance = Object.values(core.state.monsterInstances).find(inst =>
        inst.definitionName === monsterName &&
        inst.location === map.name &&
        inst.currentHp > 0
      );

      if (!instance) {
        instance = combatSystem.createMonsterInstance(monsterName, map.name);
      }

      if (!instance) return { status: 'fail_monster_unavailable', data: {}, templateKey: 'system.error' };

      core.state.combat[playerId] = {
        lockedMonsterId: instance.instanceId,
        monsterName: monsterName,
        turn: 1,
        status: 'active',
        startTime: Date.now(),
        skillCooldowns: {}
      };

      if (instance.status === 'idle') instance.status = 'combat';
 if (!instance.attackers.includes(playerId)) instance.attackers.push(playerId);
 if (instance.aggro[playerId] === undefined) instance.aggro[playerId] = 0;

      await core.emit('combat:started', playerId, monsterName, instance.instanceId);

      const res = await combatSystem.executeRound(playerId, undefined, services); // Pass services
      return { status: res.success ? 'success' : 'fail', data: { message: res.message, monsterName, monster: instance, monsterInstance: instance }, templateKey: 'system.info' };
    },

    'combat:view_monster': async (request) => {
        const { args, core } = request;
        const monsterName = args[0];
        if (!monsterName) return { status: 'fail_no_name', data: {}, templateKey: 'system.invalid_command_usage' };
        const def = core.state.monsters?.[monsterName];
        if (!def) return { status: 'not_found', data: { '怪物名': monsterName }, templateKey: 'combat:view_monster.not_found' };
        const stats = def.stats || {};
        return {
          status: 'success',
          data: {
            '怪物名': def.name,
            '怪物等级': def.level || 1,
            '怪物生命': stats.生命 || def.生命 || 0,
            '怪物攻击': stats.攻击 || def.攻击 || 0,
            '怪物防御': stats.防御 || def.防御 || 0,
            '怪物描述': def.description || '无描述',
            monster: def
          },
          templateKey: 'combat:view_monster.success'
        };
      },
    'combat:flee': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const combat = core.state.combat[playerId];
      if (!combat || combat.status !== 'active') return { status: 'fail_not_in_combat', data: {}, templateKey: 'combat:status.fail_not_in_combat' };

      const fleeChance = core.config.combat?.fleeChance || 0.5;
      const monster = core.state.monsterInstances[combat.lockedMonsterId];

      if (Math.random() < fleeChance) {
        if (monster) monster.status = 'idle';
        delete core.state.combat[playerId];
        return { status: 'success', data: {}, templateKey: 'combat:flee.success' };
      } else {
        const monsterRes = combatSystem.calculateDamage(monster.stats, player);
        let message = `逃跑失败！怪物趁机发起了攻击。\n你受到了 ${monsterRes.damage} 点伤害。`;
        if (monsterRes.dodged) {
          message += `幸运的是，你闪避了怪物的攻击。\n`;
        } else {
          // Player takes damage
          player.生命 -= monsterRes.damage;
          if (player.生命 <= 0) {
            player.生命 = 0;
            const defeat = await combatSystem._handleDefeat(playerId, monster, services); // Pass services
            message += `\n${defeat.message}`;
          }
          await services.player.modify({ playerId, changes: { 生命: player.生命 }, source: 'combat:flee' });
        }
        return { status: 'fail', data: { monster, monsterInstance: monster, 怪物名: monster.definitionName, message }, templateKey: 'combat:flee.fail' };
      }
    },

    'combat:status': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const combat = core.state.combat[playerId];
      if (!combat || combat.status !== 'active') return { status: 'fail_not_in_combat', data: {}, templateKey: 'combat:status.fail_not_in_combat' };

      const monster = core.state.monsterInstances[combat.lockedMonsterId];
      if (!monster) return { status: 'fail_no_monster', data: {}, templateKey: 'system.error' };

      // const monsterDef = combatSystem.getMonsterDefinition(monster.definitionName);

      return { status: 'success', data: { monster, player, combat }, templateKey: 'combat:status' };
    },

    'skill:use': async (request) => {
      const { playerId, args, core, services } = request;
      const player = await services.player.get(playerId);
      if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

      const skillName = args[0];
      if (!skillName) return { status: 'fail_no_skill_specified', data: {}, templateKey: 'system.invalid_command_args' };

      const skillMod = core.getModule('skill');
      if (!skillMod || !skillMod.useSkill) return { status: 'fail_skill_module_unavailable', data: {}, templateKey: 'system.error' };

      // The skill module should handle player and combat state internally now
      const res = await skillMod.useSkill(playerId, skillName, services); // Pass services
      
      // Assuming skillMod.useSkill returns { success, message, ... }
      // Need to convert to new status/templateKey format
      return { status: res.success ? 'success' : 'fail', data: res, templateKey: res.templateKey || 'system.info' };
    }
  };

  core.registerModule('combat', { doors, templates, handlers });

  // 6. 主动攻击定时器
  let aggressiveTimer = null;
  const startAggressiveCheck = () => {
    const interval = core.config.combat?.aggressiveCheckInterval || 30000;
    aggressiveTimer = setInterval(async () => {
      const maps = core.state.world.maps;
      const players = core.state.players;
      const attackedPlayers = new Set(); // 记录本次检查已被攻击过的玩家

      for (const mapName in maps) {
        const map = maps[mapName];
        const aggressiveMonsters = map.monsters.filter(m => {
          const def = combatSystem.getMonsterDefinition(m);
          return def?.aggressive;
        });

        if (aggressiveMonsters.length === 0) continue;

        // 查找在该地图的玩家
        for (const playerId in players) {
          const player = players[playerId];
          if (attackedPlayers.has(playerId)) continue;
          if (player.当前地图 === mapName && !core.state.combat[playerId]) {
            // 判定概率
            const monsterName = aggressiveMonsters[Math.floor(Math.random() * aggressiveMonsters.length)];
            const def = combatSystem.getMonsterDefinition(monsterName);
            
            if (Math.random() < (def.aggressiveChance || 0)) {
              // 触发主动攻击
              const instance = combatSystem.createMonsterInstance(monsterName, mapName);
              core.state.combat[playerId] = {
                lockedMonsterId: instance.instanceId,
                monsterName: monsterName,
                turn: 1,
                status: 'active',
                startTime: Date.now(),
                skillCooldowns: {}
              };

              attackedPlayers.add(playerId);
              core.log('info', `[主动攻击] 玩家 ${playerId} 在 ${mapName} 被 [${monsterName}] 主动攻击！`);
              
              // 怪物先手
              const monsterTurnRes = await combatSystem._executeMonsterTurn(playerId, instance, core._services); // Pass core._services for aggressive check
              
              const aggressiveTemplate = templates['combat:aggressive_attack'].text; // Use new template key
              const msg = await core.renderTemplate(aggressiveTemplate, {
                怪物名: monsterName,
                结果: monsterTurnRes.message
              }, { escape: true }, playerId);
              
              // 这里无法主动推送给玩家，通常需要 WebSocket 或记录到玩家待收消息队列
              // 本次模拟开发仅记录日志。
              core.log('info', `主动攻击结果: ${msg}`);
            }
          }
        }
      }
    }, interval);
  };

  // 监听药水使用事件，用于反击
  core.on('combat:item_used', async (playerId, itemName, quantity, result) => {
    const combat = core.state.combat[playerId];
    if (combat && combat.status === 'active') {
      const monster = core.state.monsterInstances[combat.lockedMonsterId];
      core.log('info', `战斗中使用物品，触发怪物 [${monster.definitionName}] 回合反击`);
      
      // Need to get services from core if not available globally
      const services = core._services; // Assuming core exposes _services globally for event listeners
      const monsterTurnRes = await combatSystem._executeMonsterTurn(playerId, monster, services);
      // 这里的消息可能需要记录到某种 UI 反馈中，目前仅记录日志
      core.log('info', `怪物反击结果: ${monsterTurnRes.message}`);
      
      // 触发回合结束事件 (虽然是因道具触发，但逻辑上消耗了一回合)
      combat.turn += 1;
      await core.emit('combat:round', playerId, monster.definitionName, combat.turn, core.state.players[playerId].生命, monster.currentHp);
    }
  });

  // 执行初始化
  startAggressiveCheck();

  core.combat = combatSystem;
  core.log('info', '战斗系统模块加载完成。');

  core.registerDataSource('怪物', {
    description: '怪物定义表',
    fields: ['名称','等级','分类','描述','生命','攻击','防御','经验奖励'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM monsters WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','等级':'level','分类':'category','描述':'description','经验奖励':'expReward' };
      if (map[字段]) return row[map[字段]];
      try { const st = JSON.parse(row.stats || '{}'); return st[字段]; } catch { return undefined; }
    }
  });

  return {
    moduleName: 'combat',
    unload: async () => {
      if (aggressiveTimer) clearInterval(aggressiveTimer);
      core.log('info', '战斗系统主动攻击定时器已清理。');
    },
    ...combatSystem
  };
}

combatModule.moduleName = 'combat';
combatModule.dependencies = ['database', 'player', 'map', 'backpack', 'item', 'equipment'];

module.exports = combatModule;
