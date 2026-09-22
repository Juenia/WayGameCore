/**
 * 任务系统模块 (questModule.js)
 * 支持任务接受、查看、放弃，任务数据可配置，并在 Web 编辑器中提供可视化管理界面。
 */
async function questModule(core) {
  const db = core.db;

  // 1. 初始化数据库表结构
  async function initSchema() {
    core.log('info', '[Quest] 正在初始化任务系统数据库表...');
    await db.exec(`
      CREATE TABLE IF NOT EXISTS quests (
        name TEXT PRIMARY KEY,
        description TEXT,
        category TEXT DEFAULT 'side', -- 任务分类：main, side, daily
        rewards TEXT, -- JSON 数组
        conditions TEXT, -- JSON 数组
        objectives TEXT DEFAULT '[]', -- JSON 数组 (新)
        type TEXT,
        type_value TEXT,
        npc_name TEXT DEFAULT NULL,
        enabled INTEGER DEFAULT 1,
        updated_at TEXT
      )
    `);

    // 检查列是否存在
    const tableInfo = await db.all("PRAGMA table_info(quests)");
    if (!tableInfo.some(col => col.name === 'objectives')) {
      await db.exec("ALTER TABLE quests ADD COLUMN objectives TEXT DEFAULT '[]'");
    }
    if (!tableInfo.some(col => col.name === 'category')) {
      await db.exec("ALTER TABLE quests ADD COLUMN category TEXT DEFAULT 'side'");
    }
  }

  // 2. 默认消息模板与指令将由 GameSystem 统一管理，此处不再直接插入
  // async function initDefaultData() { ... (removed) }

  // --- 核心业务逻辑 ---

  /**
  * 列表型字段（rewards / conditions / objectives）的形状归一（2026-09-22）
  * 「新手村三件套」那两条是手写的 conditions: JSON.stringify([...])，落库时 db.saveQuest
  * 又 stringify 了一次，于是 JSON.parse 出来仍是个**字符串**而不是数组 ——
  * 老代码 for...of 会按字符遍历：条件既显示不出来（永远「无」），也校验不到。
  * 这里统一收敛成数组，最多剥 3 层（正常数据 1 层就出来了）。
  */
  function normalizeList(raw) {
    let v = raw;
    for (let i = 0; i < 3 && typeof v === 'string'; i++) {
      const s = v.trim();
      if (!s) return [];
      try { v = JSON.parse(s); } catch (e) { return []; }
    }
    return Array.isArray(v) ? v : [];
  }

  /**
  * 获取任务定义
  */
  async function getQuest(name) {
    const row = await db.get('SELECT * FROM quests WHERE name = ?', [name]);
    if (row) {
      row.rewards = normalizeList(row.rewards);
      row.conditions = normalizeList(row.conditions);
      row.objectives = normalizeList(row.objectives);
    }
    return row;
  }

  /**
  * 获取所有任务
  */
  async function getAllQuests() {
    const rows = await db.all('SELECT * FROM quests');
    return rows.map(r => ({
      ...r,
      rewards: normalizeList(r.rewards),
      conditions: normalizeList(r.conditions),
      objectives: normalizeList(r.objectives)
    }));
  }

  // ── 展示层渲染（2026-09-22 重做：任务详情/列表要看得懂、要能换行）─────────────
  // 三条硬约定：
  //   ① 名字一律用【】全角方括号 —— 半角 [xxx] 会被模板引擎当变量解析并吃掉
  //      （纯文本模式下「物品 [新手长剑]」里的名字就是这么消失的）；
  //   ② 每行以 "- " 开头，纯文本与 Markdown 下都能正常分行；
  //   ③ 这里只产出行数据，排版交给 templates。
  const bulletLines = (lines) => (lines && lines.length ? lines.map((l) => `- ${l}`).join('\n') : '无');

  function getCategoryLabel(category) {
    const map = { main: '主线', side: '支线', daily: '日常' };
    return map[category] || category || '支线';
  }

  /** 目标类型归一：世界种子里写的是 collect / explore，事件侧发的是 submit_item / move。
   *  不对齐的话 collect（14 条）、explore（51 条）、talk（11 条）这三类任务永远推不动。 */
  const OBJECTIVE_TYPE_ALIASES = {
    collect: ['submit_item'],
    submit_item: ['collect'],
    explore: ['move'],
    move: ['explore']
  };
  function objectiveTypeMatches(objectiveType, eventType) {
    if (!objectiveType || !eventType) return false;
    if (objectiveType === eventType) return true;
    return (OBJECTIVE_TYPE_ALIASES[eventType] || []).includes(objectiveType);
  }

  /** 取任务的目标列表（objectives 为空时回落到老的 type/type_value 形状） */
  function getQuestObjectives(quest) {
    if (quest.objectives && Array.isArray(quest.objectives) && quest.objectives.length > 0) return quest.objectives;
    if (quest.type) {
      let targetName = quest.type_value;
      let targetAmount = 1;
      if (typeof quest.type_value === 'string' && quest.type_value.includes(':')) {
        const i = quest.type_value.lastIndexOf(':');
        targetName = quest.type_value.slice(0, i);
        targetAmount = parseInt(quest.type_value.slice(i + 1)) || 1;
      }
      return [{ type: quest.type, target: targetName, count: targetAmount }];
    }
    return [];
  }

  const getObjectiveCount = (obj) => parseInt(obj && obj.count) || 1;
  const getObjectiveProgress = (pq, idx) =>
    (pq && pq.objectives_progress && Number(pq.objectives_progress[idx])) || 0;

  /** 「初级药水（0/5）」—— 任务列表里要的就是这一行 */
  function formatObjectiveLine(obj, current) {
    return `${obj.target}（${current}/${getObjectiveCount(obj)}）`;
  }

  /** 每个目标「怎么完成」—— 之前详情页只说目标不说做法，玩家根本不知道该怎么办 */
  function getObjectiveHowTo(obj) {
    const total = getObjectiveCount(obj);
    switch (obj.type) {
      case 'kill':
        return `击败【${obj.target}】${total} 只（战斗胜利后自动记录）`;
      case 'collect':
      case 'submit_item':
        return `提交物品【${obj.target}】x${total}（指令：提交物品 ${obj.target} ${total}）`;
      case 'explore':
      case 'move':
        return `抵达地图【${obj.target}】（移动过去后自动记录）`;
      case 'talk':
        return `与 NPC【${obj.target}】对话（指令：对话 ${obj.target}）`;
      case 'level_reach':
        return `等级达到 ${total} 级（升级后自动记录）`;
      case 'attribute_reach':
        return `【${obj.target}】达到 ${total}（达标后自动记录）`;
      case 'profession_reach':
        return `职业达到【${obj.target}】（晋升后自动记录）`;
      case 'currency_reach':
        return `持有货币${obj.target}达到 ${total}（自动记录）`;
      case 'special_currency_reach':
        return `持有特殊货币达到 ${total}（自动记录）`;
      default:
        return `${getTypeLabel(obj.type)}【${obj.target}】x${total}`;
    }
  }

  /**
   * 格式化奖励描述
   */
  async function renderRewardLines(rewards, services) {
    if (!rewards || rewards.length === 0) return [];
    const desc = [];
    for (const r of rewards) {
      let line = '';
      const amount = parseInt(r.amount) || 0;
      const op = amount >= 0 ? '获得' : '扣除';
      const absAmount = Math.abs(amount);

      switch (r.type) {
        case 'level': line = `等级 +${r.value}`; break;
        case 'exp': line = `经验 +${r.value}`; break;
        case 'attribute': line = `${r.value} +${absAmount}`; break;
        case 'currency': {
          // 兼容两种奖励字段形状：value（旧）与 currencyType/currency_type（编辑器/回归脚本）—— 2026-09-14 修复
          const cv = r.value ?? r.currencyType ?? r.currency_type;
          const cName = (await services.query.getAlias(`货币${cv}`)) || `货币${cv}`;
          line = `${cName} x${absAmount}（${op}）`;
          break;
        }
        case 'special_currency': {
          const scName = (r.value ?? r.currencyType ?? null) || (await services.query.getAlias('特殊货币')) || '特殊货币';
          line = `${scName} x${absAmount}（${op}）`;
          break;
        }
        // 半角 [名字] 会被模板引擎当变量吃掉 —— 全角【】才安全（2026-09-22）
        case 'item': line = `物品【${r.value}】x${absAmount}（${op}）`; break;
        case 'equipment': line = `装备【${r.value}】x${absAmount}（${op}）`; break;
        case 'teleport_map': line = `传送到地图【${r.value}】`; break;
      }
      if (line) desc.push(line);
    }
    return desc;
  }

  async function renderRewardsDesc(rewards, services) {
    return bulletLines(await renderRewardLines(rewards, services));
  }

  /**
   * 格式化条件描述
   */
  async function renderConditionLines(conditions) {
    if (!conditions || conditions.length === 0) return [];
    const desc = [];
    for (const c of conditions) {
      let line = '';
      switch (c.type) {
        case 'level': line = `等级达到 ${c.value} 级`; break;
        case 'item': line = `持有物品【${c.value}】x${c.amount}`; break;
        case 'quest_completed': line = `完成前置任务【${c.value}】`; break;
        case 'profession_sequence': {
          const [path, seq] = String(c.value || '').split(':');
          line = `职业达到【${path}】- ${seq}`;
          break;
        }
        case 'attribute': line = `【${c.value}】达到 ${c.amount}`; break;
        case 'currency': line = `持有货币${c.value}达到 ${c.amount}`; break;
        default: line = `${c.type} ${c.value}`;
      }
      if (line) desc.push(line);
    }
    return desc;
  }

  async function renderConditionsDesc(conditions) {
    return bulletLines(await renderConditionLines(conditions));
  }

  function getTypeLabel(type) {
    const labels = {
      kill: '击杀',
      collect: '收集物品',
      submit_item: '收集物品',
      explore: '探索地图',
      move: '移动',
      talk: '对话 NPC',
      attribute_reach: '属性达标',
      level_reach: '等级达标',
      profession_reach: '职业达标',
      currency_reach: '货币达标',
      special_currency_reach: '特殊货币达标'
    };
    return labels[type] || type;
  }

  /**
   * 检查是否满足接受条件
   */
  async function checkAcceptConditions(playerId, quest, services) {
    const player = await services.player.get(playerId);
    if (!player) return { ok: false, reasons: ['找不到角色数据'] };

    // 不满足时把「差哪一条」带回去 —— 以前只说「你不满足条件」，玩家一头雾水
    const reasons = [];
    for (const c of quest.conditions) {
      switch (c.type) {
        case 'level':
          if ((player.等级 || 1) < c.value) reasons.push(`等级达到 ${c.value} 级（当前 ${player.等级 || 1} 级）`);
          break;
        case 'item': {
          // Need backpack module to check item count accurately
          const backpack = core.getModule('backpack');
          if (!backpack) { reasons.push(`持有物品【${c.value}】x${c.amount}`); break; }
          const count = await backpack.getItemCount(playerId, c.value, services);
          if (count < c.amount) reasons.push(`持有物品【${c.value}】x${c.amount}（当前 ${count}）`);
          break;
        }
        case 'quest_completed': {
          const done = player.completedQuests || player._completedQuests || [];
          if (!done.includes(c.value)) reasons.push(`先完成前置任务【${c.value}】`);
          break;
        }
        case 'profession_sequence':
          if (player.职业途径 !== c.value.split(':')[0] || player.职业序列 !== c.value.split(':')[1]) {
            reasons.push(`职业达到【${c.value.split(':')[0]}】- ${c.value.split(':')[1]}`);
          }
          break;
        case 'attribute': {
          const attrVal = player[c.value] || 0;
          if (attrVal < c.amount) reasons.push(`【${c.value}】达到 ${c.amount}（当前 ${attrVal}）`);
          break;
        }
      }
    }
    return { ok: reasons.length === 0, reasons };
  }

  /**
   * 任务详情渲染数据（接取提示与查看详情共用一套，避免两处走样）
   */
  async function buildQuestViewData(quest, playerQuest, services) {
    const objectives = getQuestObjectives(quest);
    const objectiveLines = [];
    const howToLines = [];
    let done = 0;
    objectives.forEach((o, idx) => {
      const cur = getObjectiveProgress(playerQuest, idx);
      if (cur >= getObjectiveCount(o)) done++;
      objectiveLines.push(formatObjectiveLine(o, cur));
      howToLines.push(getObjectiveHowTo(o));
    });
    const rewardLines = await renderRewardLines(quest.rewards, services);
    const conditionLines = await renderConditionLines(quest.conditions, services);

    return {
      questName: quest.name,
      quest,
      '任务名': quest.name,
      '任务介绍': quest.description || '（暂无介绍）',
      '任务分类': getCategoryLabel(quest.category),
      '任务奖励': bulletLines(rewardLines),
      '任务条件': bulletLines(conditionLines),
      '任务目标': bulletLines(objectiveLines),
      '完成方式': bulletLines(howToLines),
      '任务进度': objectives.length ? `${done}/${objectives.length}` : '—'
    };
  }

  /**
   * 发放奖励 (原子化：先检查，后发放)
   */
  async function grantRewards(playerId, quest, services, player = null) {
    if (!player) {
      player = await services.player.get(playerId);
    }
    if (!player) return false;

    const playerMod = core.getModule('player');
    const backpackMod = core.getModule('backpack');
    const playerChanges = {};

    // 1. 预检查：检查所有扣除项是否满足条件
    for (const r of quest.rewards) {
      const amount = parseInt(r.amount) || 0;
      if (amount < 0) {
        const absAmount = Math.abs(amount);
        switch (r.type) {
          case 'currency':
            const currentCurrency = player[`货币${r.value ?? r.currencyType ?? r.currency_type}`] || 0;
            if (currentCurrency < absAmount) return false;
            break;
          case 'special_currency':
            if ((player.特殊货币 || 0) < absAmount) return false;
            break;
          case 'item':
          case 'equipment':
            if (backpackMod) {
              const count = await backpackMod.getItemCount(playerId, r.value, services);
              if (count < absAmount) return false;
            } else {
              return false; // Backpack module not found
            }
            break;
        }
      }
    }

    // 2. 执行发放 (由于已经预检查，这里失败的概率极低)
    try {
      for (const r of quest.rewards) {
        const amount = parseInt(r.amount) || 0;
        // 兼容两种奖励字段形状：value（旧）与 currencyType/currency_type（编辑器/回归脚本）—— 2026-09-14 修复
        const value = r.value ?? r.currencyType ?? r.currency_type;

        switch (r.type) {
          case 'level':
            playerChanges.等级 = (player.等级 || 1) + (parseInt(value) || 0);
            break;
          case 'exp':
            playerChanges.经验 = (player.经验 || 0) + (parseInt(value) || 0);
            break;
          case 'attribute':
            playerChanges[value] = (player[value] || 0) + amount;
            break;
          case 'currency':
            await services.player.giveCurrency({
              targets: [playerId], field: `货币${value}`, amount, source: 'quest:reward'
            });
            break;
          case 'special_currency':
            await services.player.giveCurrency({
              targets: [playerId], field: '特殊货币', amount, source: 'quest:reward'
            });
            break;
          case 'item':
            if (backpackMod && backpackMod.addItem && backpackMod.removeItem) {
              if (amount < 0) {
                await backpackMod.removeItem(playerId, value, Math.abs(amount), services);
              } else {
                await backpackMod.addItem(playerId, value, amount, services);
              }
            }
            break;
          case 'equipment':
            if (backpackMod && backpackMod.addItem && backpackMod.removeItem) {
              if (amount < 0) {
                await backpackMod.removeItem(playerId, value, Math.abs(amount), services);
              } else {
                await backpackMod.addItem(playerId, value, amount, services, 'equipment');
              }
            }
            break;
          case 'teleport_map':
            playerChanges.当前地图 = value;
            break;
        }
      }
      await services.player.modify({ playerId, changes: playerChanges, source: 'quest:grant_rewards', noEmit: true });
      return true;
    } catch (err) {
      core.log('error', `[Quest] 发放奖励时发生异常: ${err.message}`);
      return false;
    }
  }

  /**
   * 完成任务
   */
  async function completeQuest(playerId, questName, services) {
    const player = await services.player.get(playerId);
    if (!player) return;

    const questIndex = (Array.isArray(player['任务']) ? player['任务'] : []).findIndex(q => q.name === questName);
    if (questIndex === -1) return;

    const quest = await getQuest(questName);
    if (!quest) return;

    // 发放奖励
    const rewardsDesc = await renderRewardsDesc(quest.rewards, services);
    const success = await grantRewards(playerId, quest, services, player); // Pass player object after changes

    if (!success) {
      core.log('warn', `[Quest] 玩家 ${playerId} 完成任务 [${questName}] 失败：奖励发放或扣除失败`);
      const msg = `❌ 任务 [${questName}] 奖励发放失败（可能由于背包满或资源不足），请检查后重试。`;
      if (core.broadcast) {
        await core.broadcast(msg, playerId);
      }
      return;
    }

    const playerChanges = {};

    // 记录完成
    // eslint-disable-next-line prefer-const
    let completedQuests = Array.isArray(player.completedQuests) ? player.completedQuests
      : (Array.isArray(player._completedQuests) ? player._completedQuests : []);
    if (!completedQuests.includes(questName)) {
      completedQuests.push(questName);
      playerChanges.completedQuests = completedQuests;   // 内存态旧键（其他逻辑读取）
      playerChanges._completedQuests = completedQuests;  // _ 前缀随 meta_json 持久化 —— 2026-09-14 修复
    }

    // 移除进行中的任务
    let currentQuests = Array.isArray(player['任务']) ? [...player['任务']] : [];
    currentQuests.splice(questIndex, 1);
    playerChanges['任务'] = currentQuests;
    
    await services.player.modify({ playerId, changes: playerChanges, source: 'quest:complete', noEmit: true });

    // 发送模板消息
    const msgData = {
      questName: questName,
      rewardsDesc: rewardsDesc
    };
    
    core.log('info', `[Quest] 玩家 ${playerId} 完成任务 [${questName}]`);

    // 完成回执（2026-09-22 补）：以前只 emit 一个**没人监听**的事件，玩家打完最后一只怪
    // 一点反馈都没有 —— 任务「悄悄完成」了，玩家自然觉得「没有完成任务的方式」。
    // 这里用本模块的模板自己渲染再推送：模板里的 {xxx|raw} 不会被 Markdown 转义成 \- \+
    // （DB 里那两条 accept_success / complete_success 用的是 [xxx]，推出去会带反斜杠）。
    try {
      if (typeof core.push === 'function') {
        const mode = core.getMessageMode ? core.getMessageMode() : 1;
        const content = await core.renderTemplate(
          QUEST_COMPLETE_TEMPLATE,
          { ...msgData, '任务名': questName, '任务奖励': rewardsDesc },
          { escape: false },
          playerId
        );
        const pushRes = await core.push({
          type: 'player',
          id: playerId,
          msg_type: mode === 2 ? 'markdown' : 'text',
          content,
          dedupe_key: `quest_done_${questName}`,
          dedupe_window: 300
        });
        if (pushRes && pushRes.ok === false && pushRes.error !== 'deduped') {
          core.log('warn', `[Quest] 完成回执未能推送（${pushRes.error}），玩家 ${playerId} 可能不在线。`);
        }
      }
    } catch (e) {
      core.log('warn', `[Quest] 完成回执推送失败: ${e.message}`);
    }

    core.emit('quest:completed', playerId, questName, rewardsDesc, msgData);
  }

  /**
   * 检查任务进度
   */
  async function checkQuestProgress(playerId, type, target, amount = 1, services) {
    const player = await services.player.get(playerId);
    if (!player || !player['任务'] || !Array.isArray(player['任务'])) return;

    let playerChanged = false;
    const questsToUpdate = [...player['任务']]; // Work on a copy

    for (let i = 0; i < questsToUpdate.length; i++) {
      const pq = questsToUpdate[i];
      if (pq.completed) continue;

      const quest = await getQuest(pq.name);
      if (!quest || !quest.enabled) continue;

      const objectives = getQuestObjectives(quest);
      if (objectives.length === 0) continue;

      if (!pq.objectives_progress) pq.objectives_progress = {};

      let questProgressChanged = false;
      for (let objIdx = 0; objIdx < objectives.length; objIdx++) {
        const obj = objectives[objIdx];
        // 类型归一：collect↔submit_item、explore↔move（2026-09-22）
        if (!objectiveTypeMatches(obj.type, type)) continue;

        let isMatch = false;
        if (obj.target === target) {
          isMatch = true;
        } else if (obj.type === 'currency_reach' && target === `货币${obj.target}`) {
          isMatch = true;
        } else if (obj.type === 'special_currency_reach' && target === '特殊货币') {
          isMatch = true;
        } else if (obj.type === 'level_reach' && (target === '等级' || !isNaN(parseInt(target)))) {
          isMatch = true;
        } else if (['attribute_reach', 'profession_reach'].includes(obj.type)) {
          if (target === obj.target || (target && target.startsWith(obj.target))) {
            isMatch = true;
          }
        }

        if (isMatch) {
          if (['attribute_reach', 'level_reach', 'profession_reach', 'currency_reach', 'special_currency_reach'].includes(obj.type)) {
            let currentVal = 0;
            if (obj.type === 'level_reach') currentVal = player.等级 || 1;
            else if (obj.type === 'attribute_reach') currentVal = player[obj.target] || 0;
            else if (obj.type === 'profession_reach') {
              const [path, seq] = obj.target.split(':');
              if (player.职业途径 === path && player.职业序列 === seq) currentVal = 1;
              else currentVal = 0;
            } else if (obj.type === 'currency_reach') currentVal = player[`货币${obj.target}`] || 0;
            else if (obj.type === 'special_currency_reach') currentVal = player.特殊货币 || 0;

            if (pq.objectives_progress[objIdx] !== currentVal) { // Only update if value changed
              pq.objectives_progress[objIdx] = currentVal;
              questProgressChanged = true;
              playerChanged = true;
            }
          } else {
            const newProgress = (pq.objectives_progress[objIdx] || 0) + amount;
            if (pq.objectives_progress[objIdx] !== newProgress) {
              pq.objectives_progress[objIdx] = newProgress;
              questProgressChanged = true;
              playerChanged = true;
            }
          }
        }
      }

      if (questProgressChanged) {
        // Check if all objectives are now complete
        let allDone = true;
        for (let objIdx = 0; objIdx < objectives.length; objIdx++) {
          const obj = objectives[objIdx];
          const progress = pq.objectives_progress[objIdx] || 0;
          const targetVal = parseInt(obj.count) || 1;
          if (progress < targetVal) {
            allDone = false;
            break;
          }
        }

        if (allDone) {
          pq.completed = true;
          playerChanged = true; // Mark player as changed due to quest completion flag
          await completeQuest(playerId, pq.name, services);
          // completeQuest modifies player['任务'] and saves, so we need to re-fetch player data
          // or just exit this loop and function as state is changed significantly
          return;
        }
      }
    }

    if (playerChanged) {
      // Save player state if any progress was updated (but not completed)
      await services.player.modify({ playerId, changes: { '任务': questsToUpdate }, source: 'quest:progress_update', noEmit: true });
    }
  }

  // 完成回执文案（放模块级常量：completeQuest 与 registerModule 两处共用）
  const QUEST_COMPLETE_TEMPLATE = {
    text: '🎉 任务完成！\n\n📜 【{任务名|raw}】\n\n🎁 获得奖励\n{任务奖励|raw}\n\n💡 输入「查看任务」看看还有什么可做。',
    markdown: '### 🎉 任务完成！\n\n> 📜 **【{任务名|raw}】**\n\n**🎁 获得奖励**\n\n{任务奖励|raw}\n\n> 💡 输入「查看任务」看看还有什么可做。'
  };

  core.registerModule('quest', {
    doors: [
      { logical_name: 'quest:accept', default_triggers: ['接受任务', 'accept', 'jsrw'], description: '接受指定任务' },
      { logical_name: 'quest:view', default_triggers: ['查看任务', 'quests', 'ckrw'], description: '查看进行中的任务' },
      { logical_name: 'quest:abandon', default_triggers: ['放弃任务', 'abandon', 'fqrw'], description: '放弃进行中的任务' }
    ],
    templates: {
      // 接取成功直接把「要求 / 怎么完成 / 奖励」摊开给玩家看（用户反馈 #1）—— 2026-09-22
      'quest:accept.success': { text: "✨ 接受任务成功！\n\n📜 【{任务名|raw}】· {任务分类|raw}\n{任务介绍|raw}\n\n🎯 任务目标\n{任务目标|raw}\n\n✅ 完成方式\n{完成方式|raw}\n\n🎁 任务奖励\n{任务奖励|raw}\n\n💡 输入「查看任务」可随时查看进度。", markdown: "### ✨ 接受任务成功\n\n> 📜 **【{任务名|raw}】** · {任务分类|raw}\n\n{任务介绍|raw}\n\n**🎯 任务目标**\n\n{任务目标|raw}\n\n**✅ 完成方式**\n\n{完成方式|raw}\n\n**🎁 任务奖励**\n\n{任务奖励|raw}\n\n> 💡 输入「查看任务」可随时查看进度。" },
      'quest:accept.fail_condition': { text: '❌ 还不能接受任务【{任务名|raw}】\n还差：\n{缺少条件|raw}', markdown: '### ❌ 还不能接受任务【{任务名|raw}】\n\n**还差这些条件**\n\n{缺少条件|raw}' },
      'quest:accept.fail_notfound': { text: '❌ 任务 [任务名] 不存在或不可用。', markdown: '❌ 任务 [任务名] 不存在或不可用。' },
      'quest:accept.fail_exists': { text: '❌ 你已经接受过任务 [任务名] 了。', markdown: '❌ 你已经接受过任务 [任务名] 了。' },
      // 详情页换行/分块重做（用户反馈 #4）：{字段|raw} 原样落字，不会被 Markdown 转义成 \- \+
      'quest:view.detail': { text: "📜 【{任务名|raw}】· {任务分类|raw}\n{任务介绍|raw}\n\n🎯 任务目标（完成 {任务进度|raw}）\n{任务目标|raw}\n\n✅ 完成方式\n{完成方式|raw}\n\n🎁 任务奖励\n{任务奖励|raw}\n\n🔒 接受条件\n{任务条件|raw}", markdown: "### 📜 【{任务名|raw}】· {任务分类|raw}\n\n{任务介绍|raw}\n\n**🎯 任务目标**　（完成 {任务进度|raw}）\n\n{任务目标|raw}\n\n**✅ 完成方式**\n\n{完成方式|raw}\n\n**🎁 任务奖励**\n\n{任务奖励|raw}\n\n**🔒 接受条件**\n\n{任务条件|raw}" },
      'quest:view.list': { text: '📋 进行中的任务（{任务数量|raw}）\n\n{任务列表|raw}\n\n💡 输入「查看任务 任务名」看详情。', markdown: '### 📋 进行中的任务（{任务数量|raw}）\n\n{任务列表|raw}\n\n> 💡 输入「查看任务 任务名」看详情。' },
      'quest:view.list_empty': { text: '📋 你当前没有进行中的任务。\n💡 去 NPC 那里接任务，或输入「帮助」查看全部指令。', markdown: '### 📋 你当前没有进行中的任务\n\n> 去 NPC 那里接任务，或输入「帮助」查看全部指令。' },
      'quest:abandon.success': { text: '🗑️ 你放弃了任务 [任务名]。', markdown: '🗑️ 你放弃了任务 [任务名]。' },
      'quest:abandon.fail_not_accepted': { text: '❌ 你没有接受任务 [任务名]。', markdown: '❌ 你没有接受任务 [任务名]。' },
      'quest:complete.success': QUEST_COMPLETE_TEMPLATE,
      'quest:accept.fail_npc_location': { text: '❌ 必须到 NPC [NPC名] 所在地图才能接受此任务。', markdown: '❌ 必须到 NPC [NPC名] 所在地图才能接受此任务。' }
    },
    handlers: {
      'quest:accept': async (request) => {
        const { playerId, args, services } = request;
        const questName = args[0];
        if (!questName) return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };
    
        const quest = await getQuest(questName);
        if (!quest || !quest.enabled) {
          return { status: 'fail_notfound', data: { '任务名': questName }, templateKey: 'quest:accept.fail_notfound' };
        }
    
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };
    
        const playerQuests = Array.isArray(player['任务']) ? player['任务'] : [];
        if (playerQuests.find(q => q.name === questName)) {
          return { status: 'fail_exists', data: { '任务名': questName }, templateKey: 'quest:accept.fail_exists' };
        }
    
        // 检查条件
        const condResult = await checkAcceptConditions(playerId, quest, services);
        if (!condResult.ok) {
          return {
            status: 'fail_condition',
            data: { '任务名': questName, '缺少条件': bulletLines(condResult.reasons) },
            templateKey: 'quest:accept.fail_condition'
          };
        }
    
        // 检查 NPC 地图限制
        if (quest.npc_name) {
          const npc = core.state.npcs?.[quest.npc_name]; // Assuming core.state.npcs is available
          const currentMap = player.当前地图 || player.初始地图;
          if (!npc || npc.map_name !== currentMap) {
            return { status: 'fail_npc_location', data: { questName, npcName: quest.npc_name, '任务名': questName, 'NPC名': quest.npc_name }, templateKey: 'quest:accept.fail_npc_location' };
          }
        }
    
        // 加入列表
        const newQuestEntry = {
          name: questName,
          progress: 0, // Deprecated, but keep for compatibility if needed
          completed: false,
          objectives_progress: {} // Initialize new progress tracking
        };
        const updatedQuests = [...playerQuests, newQuestEntry];

        await services.player.modify({ playerId, changes: { '任务': updatedQuests }, source: 'quest:accept', noEmit: true });

        // 「站在这张图接的探索任务」当场记一笔 —— 否则要玩家先走开再走回来才算数
        await checkQuestProgress(playerId, 'explore', player.当前地图 || player.初始地图, 1, services);

        // 接取回执：把任务要求一并摊开（用户反馈 #1）
        const acceptedPlayer = await services.player.get(playerId);
        const acceptedEntry = (Array.isArray(acceptedPlayer['任务']) ? acceptedPlayer['任务'] : []).find(q => q.name === questName);
        const acceptData = await buildQuestViewData(quest, acceptedEntry, services);

        return { status: 'success', data: acceptData, templateKey: 'quest:accept.success' };
      },
    
      'quest:view': async (request) => {
        const { playerId, args, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };
    
        const questName = args[0];
        if (questName) {
          // 查看详情
          const quest = await getQuest(questName);
          if (!quest) {
            return { status: 'fail_notfound', data: { '任务名': questName }, templateKey: 'quest:accept.fail_notfound' };
          }
          
          const playerQuest = (Array.isArray(player['任务']) ? player['任务'] : []).find(q => q.name === questName);
          const detailData = await buildQuestViewData(quest, playerQuest, services);

          return { status: 'success', data: detailData, templateKey: 'quest:view.detail' };
        } else {
          // 列出所有进行中的任务
          if (!Array.isArray(player['任务']) || player['任务'].length === 0) {
            return { status: 'empty', templateKey: 'quest:view.list_empty' };
          }

          // 列表按用户要求的分层展示（用户反馈 #3）：
          //   1. 收集草药 · 支线
          //      - 初级药水（0/5）
          const questBlocks = [];
          let seq = 0;
          for (const pq of player['任务']) {
            seq++;
            const quest = await getQuest(pq.name);
            if (!quest) {
              questBlocks.push(`${seq}. ${pq.name}\n   - 任务数据缺失（可能已被删除）`);
              continue;
            }
            const objectives = getQuestObjectives(quest);
            const lines = [`${seq}. ${quest.name} · ${getCategoryLabel(quest.category)}`];
            if (objectives.length > 0) {
              objectives.forEach((o, idx) => {
                lines.push(`   - ${formatObjectiveLine(o, getObjectiveProgress(pq, idx))}`);
              });
            } else {
              lines.push('   - （该任务没有配置目标）');
            }
            questBlocks.push(lines.join('\n'));
          }
          const questList = questBlocks.join('\n');

          return {
            status: 'success',
            data: { '任务列表': questList, questList, '任务数量': String(player['任务'].length) },
            templateKey: 'quest:view.list'
          };
        }
      },
    
      'quest:abandon': async (request) => {
        const { playerId, args, services } = request;
        const questName = args[0];
        if (!questName) return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };
    
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };
    
        const playerQuests = Array.isArray(player['任务']) ? player['任务'] : [];
        const index = playerQuests.findIndex(q => q.name === questName);
        if (index === -1) {
          return { status: 'fail_not_accepted', data: { '任务名': questName }, templateKey: 'quest:abandon.fail_not_accepted' };
        }
    
        const updatedQuests = [...playerQuests];
        updatedQuests.splice(index, 1);
        await services.player.modify({ playerId, changes: { '任务': updatedQuests }, source: 'quest:complete', noEmit: true });
    
        return { status: 'success', data: { '任务名': questName }, templateKey: 'quest:abandon.success' };
      }
    }
  });

  // --- 事件监听 ---

  // All event listeners need to pass core.services
  // This assumes core.services is available and initialized when events fire

  core.on('enemy:killed', async (playerId, monsterName) => {
    if (core.services) await checkQuestProgress(playerId, 'kill', monsterName, 1, core.services);
  });

  // 「收集 X 个」—— 走背包的提交/上交（提交物品 指令），对应 collect 与 submit_item 两种写法
  core.on('backpack:item_submitted', async (playerId, itemName, amount) => {
    if (core.services) await checkQuestProgress(playerId, 'submit_item', itemName, amount, core.services);
  });

  // 「抵达/探索某地图」（2026-09-22 补）：世界里 51 条 explore 任务以前**没有任何监听**，
  // mapModule 一直在发 player:moved，任务侧却没人接 —— 现在接上。
  core.on('player:moved', async (playerId, fromMap, toMap) => {
    if (core.services && toMap) await checkQuestProgress(playerId, 'explore', toMap, 1, core.services);
  });

  // 「与某 NPC 对话」（2026-09-22 补）：由 npcModule 的对话成功分支发出。
  core.on('npc:talked', async (playerId, npcName, mapName) => {
    if (core.services && npcName) await checkQuestProgress(playerId, 'talk', npcName, 1, core.services);
  });

  core.on('player:level_up', async (playerId, oldLv, newLv) => {
    if (core.services) await checkQuestProgress(playerId, 'level_reach', String(newLv), 0, core.services);
  });

  core.on('player:attribute_changed', async (playerId, field, value) => {
    if (core.services) await checkQuestProgress(playerId, 'attribute_reach', field, 0, core.services);
  });

  core.on('profession:promoted', async (playerId, sequenceName) => {
    if (core.services) {
      const player = await core.services.player.get(playerId);
      if (player) {
        await checkQuestProgress(playerId, 'profession_reach', player.职业途径, 0, core.services);
      }
    }
  });

  core.on('player:currency_changed', async (playerId, field, value) => {
    if (core.services) await checkQuestProgress(playerId, 'currency_reach', field, 0, core.services);
  });

  core.on('player:special_currency_changed', async (playerId, value) => {
    if (core.services) await checkQuestProgress(playerId, 'special_currency_reach', '特殊货币', 0, core.services);
  });

  // --- 初始化流程 ---
  await initSchema();
  // await initDefaultData(); // Removed

  // ── 世界种子的任务列补齐（2026-09-19 内容源合并）────────────────────────────
  // core 的 db.saveQuest 只写 name/description/rewards/conditions/type/type_value/npc_name/enabled，
  // 不写 category 与 objectives。空库新装时这两列会落到表默认值（'side' / '[]'），
  // 于是 124 条任务的 objectives、53 条主线的 category 会丢。这里按世界种子补：
  // 判定看 updated_at（本次启动这几秒内才自动种下的行才算），绝不覆盖主人自己改过的内容。
  async function fillQuestWorldColumns() {
    const { worldSeed } = require('./world/load.js');
    const rows = worldSeed('quests', []);
    if (!rows.length) return 0;
    // 只补「本次启动刚刚自动种下的行」：seed 写入的 updated_at 就是这几秒内。
    // 主人自己改过的老行时间戳是旧的 → 直接跳过，一个字都不动。
    const bootFloor = new Date(Date.now() - 10000).toISOString();
    let filled = 0;
    for (const q of rows) {
      if (!q || !q.name) continue;
      const cur = await db.get('SELECT category, objectives, updated_at FROM quests WHERE name = ?', [q.name]);
      if (!cur || !cur.updated_at || String(cur.updated_at) < bootFloor) continue;
      const curObjectives = cur.objectives === null || cur.objectives === undefined ? '' : String(cur.objectives);
      const worldObjectives = JSON.stringify(q.objectives === undefined ? [] : q.objectives);
      const needCategory = (!cur.category || cur.category === 'side') && !!q.category && q.category !== cur.category;
      const needObjectives = (curObjectives === '' || curObjectives === '[]') && worldObjectives !== '[]';
      if (!needCategory && !needObjectives) continue;
      await db.run('UPDATE quests SET category = ?, objectives = ? WHERE name = ?', [
        needCategory ? q.category : cur.category,
        needObjectives ? worldObjectives : curObjectives,
        q.name
      ]);
      filled++;
    }
    return filled;
  }
  const filledQuestWorldColumns = await fillQuestWorldColumns();
  if (filledQuestWorldColumns) {
    core.log('info', `[Quest] 按世界种子补齐了 ${filledQuestWorldColumns} 条任务的分类/目标列。`);
  }

  core.log('info', '[Quest] 任务系统模块加载完成。');

  core.registerDataSource('任务', {
    description: '任务定义表',
    fields: ['名称','描述','等级要求'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM quests WHERE name=?', [对象]);
      if (!row) return undefined;
      const map = { '名称':'name','描述':'description','等级要求':'level_required' };
      return row[map[字段]];
    }
  });

  // 导出接口供 API 调用
  return {
    moduleName: 'quest',
    getQuest,
    getAllQuests,
    checkQuestProgress,
    completeQuest,
    saveQuest: async (name, data) => {
      const now = new Date().toISOString();
      
      let objectives = data.objectives || [];
      let type = data.type;
      let type_value = data.type_value;

      if (objectives.length > 0) {
        const first = objectives[0];
        type = first.type;
        type_value = first.target + (first.count > 1 ? `:${first.count}` : '');
      } else if (type) {
        let targetName = type_value;
        let targetCount = 1;
        if (typeof type_value === 'string' && type_value.includes(':')) {
          const parts = type_value.split(':');
          targetName = parts[0];
          targetCount = parseInt(parts[1]) || 1;
        }
        objectives = [{ type: type, target: targetName, count: targetCount }];
      }

      const existing = await db.get('SELECT name FROM quests WHERE name = ?', [name]);
      if (existing) {
        await db.run(
          'UPDATE quests SET description = ?, category = ?, rewards = ?, conditions = ?, objectives = ?, type = ?, type_value = ?, npc_name = ?, enabled = ?, updated_at = ? WHERE name = ?',
          [data.description, data.category || 'side', JSON.stringify(data.rewards || []), JSON.stringify(data.conditions || []), JSON.stringify(objectives), type, type_value, data.npc_name || null, data.enabled ? 1 : 0, now, name]
        );
      } else {
        await db.run(
          'INSERT INTO quests (name, description, category, rewards, conditions, objectives, type, type_value, npc_name, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [name, data.description, data.category || 'side', JSON.stringify(data.rewards || []), JSON.stringify(data.conditions || []), JSON.stringify(objectives), type, type_value, data.npc_name || null, data.enabled ? 1 : 0, now]
        );
      }
    },
    deleteQuest: async (name) => {
      await db.run('DELETE FROM quests WHERE name = ?', [name]);
    }
  };
}

questModule.moduleName = 'quest';
module.exports = questModule;