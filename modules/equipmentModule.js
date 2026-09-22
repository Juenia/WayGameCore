/**
 * 装备系统模块 - 处理装备部位、穿戴卸下、套装与封印解封
 */
async function equipmentModule(core) {
  core.log('info', '正在加载装备系统模块...');

  // 1. 核心状态与定义
  const slotRegistry = new Map(); // id -> { id, name, description }
  const equipmentDefinitions = new Map(); // name -> definition
  const setDefinitions = new Map(); // setName -> { name, items: [], bonus: {} }

  const { worldSeed } = require('./world/load.js');

  // 2. 默认装备部位数据
  const defaultSlots = [
    { id: 'weapon', name: '手持', description: '武器部位' },
    { id: 'head', name: '头部', description: '头盔部位' },
    { id: 'body', name: '身体', description: '护甲部位' },
    { id: 'accessory', name: '饰品', description: '饰品部位' }
  ];

  // 3. 默认装备数据
  // 辅助函数：兼容旧格式（字符串单技能）和新格式（JSON 数组多技能）
  function getEquipSkills(def) {
    if (!def || !def.skill) return [];
    const s = def.skill;
    if (Array.isArray(s)) return s.filter(x => x);
    if (typeof s === 'string') {
      const trimmed = s.trim();
      if (!trimmed) return [];
      // 尝试解析 JSON 数组
      if (trimmed.startsWith('[')) {
        try { const arr = JSON.parse(trimmed); return Array.isArray(arr) ? arr.filter(x => x) : [trimmed]; }
        catch { return [trimmed]; }
      }
      return [trimmed];
    }
    return [];
  }

  const defaultEquipment = {
    '木剑': {
      name: '木剑', category: '装备', slot_id: 'weapon', level_required: 1, class_required: null,
      stats: { 攻击: 2 }, skill: null, setEffect: null, sealed: false, description: '练习用的木剑'
    },
    '木盾': {
      name: '木盾', category: '装备', slot_id: 'accessory', level_required: 1, class_required: null,
      stats: { 防御: 2 }, skill: null, setEffect: null, sealed: false, description: '简陋的木质盾牌'
    },
    '铁剑': {
      name: '铁剑', category: '装备', slot_id: 'weapon', level_required: 1, class_required: null,
      stats: { 攻击: 5 }, skill: null, setEffect: null, sealed: false, description: '普通的铁剑'
    },
    '精钢剑': {
      name: '精钢剑', category: '装备', slot_id: 'weapon', level_required: 5, class_required: '战士',
    // 注（2026-09-19 覆盖校验）：这里的「战士」是**模块默认数据自己的旧世界职业**（professionModule.js:23 定义了它，
    // 还有见习/正式三阶）。当前 DB 跟的是 tools/world-professions.js 那套 21 职业，没有战士 ——
    // 所以"对不上"是两个内容源的问题，不是这行写错。别按 DB 去改这里。

      stats: { 攻击: 15 }, skill: '斩击', setEffect: '剑士套装', sealed: false, description: '精钢打造的长剑'
    },
    '暗影之刃': {
      name: '暗影之刃', category: '装备', slot_id: 'weapon', level_required: 10, class_required: null,
      stats: { 攻击: 30, 暴击率: 5 }, skill: '暗影突袭', setEffect: null, sealed: true, 
      unsealMaterials: [{ itemName: '解封石', quantity: 3 }], description: '散发着幽暗气息的短刃'
    },
    '布帽': {
      name: '布帽', category: '装备', slot_id: 'head', level_required: 1, class_required: null,
      stats: { 防御: 2 }, skill: null, setEffect: null, sealed: false, description: '简单的布帽'
    },
    '铁盔': {
      name: '铁盔', category: '装备', slot_id: 'head', level_required: 3, class_required: null,
      stats: { 防御: 5 }, skill: null, setEffect: '剑士套装', sealed: false, description: '坚固的铁制头盔'
    },
    '布甲': {
      name: '布甲', category: '装备', slot_id: 'body', level_required: 1, class_required: null,
      stats: { 防御: 3 }, skill: null, setEffect: null, sealed: false, description: '粗布缝制的护甲'
    },
    '铁甲': {
      name: '铁甲', category: '装备', slot_id: 'body', level_required: 5, class_required: null,
      stats: { 防御: 10, 生命: 50 }, skill: null, setEffect: '剑士套装', sealed: false, description: '沉重的铁制胸甲'
    },
    '力量戒指': {
      name: '力量戒指', category: '装备', slot_id: 'accessory', level_required: 1, class_required: null,
      stats: { 攻击: 3 }, skill: null, setEffect: null, sealed: false, description: '提升力量的戒指'
    }
  };

  // 默认套装数据
  const defaultSets = {
    '剑士套装': {
      name: '剑士套装',
      components: ['精钢剑', '铁盔', '铁甲'],
      effects: {
        tiers: [
          { requiredCount: 2, effects: [{ type: 'attribute', attr: '攻击', value: 5 }] },
          { requiredCount: 3, effects: [{ type: 'attribute', attr: '攻击', value: 10 }, { type: 'attribute', attr: '生命', value: 100 }] }
        ]
      },
      description: '剑士的基础套装'
    }
  };

  // 4. 部位管理方法实现
  const equipmentSystem = {
    /**
     * 初始化部位与变量
     */
    init: async () => {
      // 从数据库读取部位
      // ── 世界种子合并（2026-09-19）──────────────────────────────────────────
      // modules/world/*.json 是从当前正式世界（data/game.db）导出的内容种子，是唯一真源；
      // 下面的内置部位/装备/套装只在种子文件缺失/为空时兜底。已有库完全不受影响。
      const seedSlots = worldSeed('equipment_slots', defaultSlots);
      const seedEquipment = worldSeed('equipment', Object.values(defaultEquipment));
      const seedSets = worldSeed('equipment_sets', Object.values(defaultSets));
      let dbSlots = await core._queryService.list('equipment_slots');
      if (dbSlots.length === 0) {
        // 如果数据库为空，写入世界种子部位
        for (const slot of seedSlots) {
          await core.db.saveSlot(slot.id, slot.name, slot.description);
        }
        dbSlots = await core._queryService.list('equipment_slots');
      }

      for (const slot of dbSlots) {
        slotRegistry.set(slot.id, slot);
        // 同时支持通过名称查找部位，增加容错性
        slotRegistry.set(slot.name, slot);
        equipmentSystem._registerSlotVariable(slot);
      }

      // 初始化装备定义数据库
      const dbEquip = await core._queryService.list('equipment');
      if (dbEquip.length === 0) {
        core.log('info', `数据库装备表为空，正在写入世界种子装备数据（${seedEquipment.length} 件）...`);
        for (const def of seedEquipment) {
          await core.db.saveEquipment(def.name, def);
        }
      }

      // 初始化套装定义数据库
      const dbSets = await core._queryService.list('equipment_sets');
      if (dbSets.length === 0) {
        core.log('info', `数据库套装表为空，正在写入世界种子套装数据（${seedSets.length} 套）...`);
        for (const def of seedSets) {
          await core.db.saveEquipmentSet(def);
        }
      }

      // 注册装备查询相关的系统变量
      core.registerSystemVariable('装备名', (p, core, ctx) => ctx.装备名 || ctx.name || (ctx.item ? ctx.item.name : ''));
      core.registerSystemVariable('装备所属部位', (p, core, ctx) => {
        const sid = ctx.装备所属部位 || (ctx.item ? ctx.item.slot_id : '');
        const slot = slotRegistry.get(sid);
        return slot ? slot.name : sid;
      });
      core.registerSystemVariable('装备介绍', (p, core, ctx) => ctx.装备介绍 || (ctx.item ? ctx.item.description : '无'));
      core.registerSystemVariable('装备等级限制', (p, core, ctx) => ctx.装备等级限制 || (ctx.item ? ctx.item.level_required : 0));
      core.registerSystemVariable('装备职业途径限制', (p, core, ctx) => ctx.装备职业途径限制 || ((ctx.item && ctx.item.class_required) ? ctx.item.class_required : ''));
      core.registerSystemVariable('装备提供基础属性', (p, core, ctx) => {
        const stats = ctx.item ? ctx.item.stats : ctx.stats;
        if (!stats) return '无';
        return Object.entries(stats).map(([k, v]) => `${k}+${v}`).join(', ');
      });
      core.registerSystemVariable('装备附带技能', (p, core, ctx) => { if (ctx.装备附带技能) return ctx.装备附带技能; const arr = getEquipSkills(ctx.item); return arr.length ? arr.join(' / ') : '无'; });
      core.registerSystemVariable('装备封印状态', (p, core, ctx) => ctx.装备封印状态 || (ctx.item ? (ctx.item.sealed ? '已封印' : '未封印') : '未知'));
      core.registerSystemVariable('装备所属套装', (p, core, ctx) => ctx.装备所属套装 || (ctx.item ? ctx.item.setEffect : '无') || '无');

      // 从数据库加载全量定义到内存
      const finalEquip = await core.db.getAllEquipment();
      const finalSets = await core.db.getAllEquipmentSets();

      finalEquip.forEach(e => {
        equipmentDefinitions.set(e.name, e);
      });
      finalSets.forEach(s => {
        setDefinitions.set(s.name, s);
      });

      core.updateState('equipmentDefinitions', Object.fromEntries(equipmentDefinitions));
      core.updateState('setDefinitions', Object.fromEntries(setDefinitions));
      
      // 向背包注册分类
      const backpack = core.getModule('backpack');
      if (backpack?.registerCategory) {
        backpack.registerCategory('装备', 'equipment');
      }
    },

    /**
     * 注册部位对应的系统变量
     */
    _registerSlotVariable: (slot) => {
      core.registerSystemVariable(slot.name, async (playerId, core) => {
        const player = await core._playerService.get(playerId);
        if (!player || !player.装备栏) return '';
        return player.装备栏[slot.id] || '';
      });
    },

    /**
     * 添加部位
     */
    addSlot: async (id, name, description = '') => {
      await core.db.saveSlot(id, name, description);
      const slot = { id, name, description };
      slotRegistry.set(id, slot);
      equipmentSystem._registerSlotVariable(slot);
      
      // 同步更新所有已在线玩家的状态 (这里简单处理，新部位默认为 null)
      // 遍历所有玩家，如果他们的装备栏中没有这个槽位，则添加
      const allPlayersData = await core.db.getAllPlayers(); // 获取所有玩家（players.db，2026-09-14 修复双库违规）
      for (const pData of allPlayersData) {
        const playerId = pData.id; // 从简化数据中获取 ID
        const player = await core._playerService.get(playerId); // 获取完整的玩家数据
        if (player && player.装备栏 && player.装备栏[id] === undefined) {
          const newEquipmentSlots = { ...player.装备栏, [id]: null };
          await core._playerService.modify({ playerId, changes: { 装备栏: newEquipmentSlots }, source: 'equipment:addSlot' });
        }
      }
      core.log('info', `装备系统已新增部位: ${name} (ID: ${id})`);
    },

    /**
     * 删除部位
     */
    removeSlot: async (id) => {
      const slot = slotRegistry.get(id);
      if (!slot) return;

      // 检查是否有玩家装备在该部位
      const players = await core.db.getAllPlayers(); // 2026-09-14 修复双库违规
      for (const pData of players) {
        const player = await core._playerService.get(pData.id);
        if (player && player.装备栏 && player.装备栏[id]) {
          throw new Error(`无法删除部位 ${slot.name}：玩家 ${player.昵称} 仍在该部位穿戴装备。`);
        }
      }

      await core.db.deleteSlot(id);
      core.removeSystemVariable(slot.name);
      slotRegistry.delete(id);
      core.log('info', `装备系统已移除部位: ${slot.name}`);
    },

    getSlot: (id) => slotRegistry.get(id),
    getAllSlots: () => {
      // slotRegistry 同时以 id 和 name 为键注册同一对象，需按 id 去重
      const seen = new Set();
      const out = [];
      for (const s of slotRegistry.values()) {
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        out.push(s);
      }
      return out;
    },

    getDefinition: (name) => {
      // 1. 先从内存查 (含默认装备和已加载的装备)
      const def = core.state.equipmentDefinitions?.[name] || equipmentDefinitions.get(name);
      if (def) return def;
      return null;
    },

    /**
     * 异步获取装备定义 (含数据库查询)
     */
    getDefinitionAsync: async (name) => {
      const def = equipmentSystem.getDefinition(name);
      if (def) return def;
      
      if (core.db?.getEquipment) {
        const dbDef = await core.db.getEquipment(name);
        if (dbDef) return dbDef;
      }
      return null;
    },

    /**
     * 穿戴装备
     */
    equipItem: async (playerId, equipmentName, services) => {
      const def = core.equipment.getDefinition(equipmentName);
      if (!def) return { success: false, reason: 'no_definition', message: '未找到该装备的定义。' };

      if (def.category !== '装备') return { success: false, reason: 'not_equipment', message: '该物品不是装备。' };

      const player = await services.player.get(playerId);
      if (!player) return { success: false, reason: 'no_player', message: '玩家数据不存在。' };

      // 1. 条件检查
      if (def.sealed) return { success: false, reason: 'sealed', message: '封印物未解封无法装备。' };
      if (player.等级 < (def.level_required || 0)) {
        return { success: false, reason: 'level_insufficient', message: `等级不足，需要达到 ${def.level_required} 级。` };
      }
      if (def.class_required && player.职业途径 !== def.class_required) {
        return { success: false, reason: 'class_mismatch', message: `职业不符，仅限 ${def.class_required} 使用。` };
      }
      if (!player.背包 || !player.背包[equipmentName] || player.背包[equipmentName] < 1) {
        return { success: false, reason: 'no_item', message: '你的背包中没有这件装备。' };
      }

      // 2. 部位处理
      const rawSlotId = def.slot_id || def.slotId;
      const slot = slotRegistry.get(rawSlotId);
      if (!slot) return { success: false, reason: 'invalid_slot', message: '无效的装备部位。' };
      
      const slot_id = slot.id; // 统一部位标识为英文 ID

      // 初始化装备栏
      if (!player.装备栏) player.装备栏 = {};
      
      let message = `装备 ${equipmentName} 成功！\n部位：${slot.name}\n`;
      const oldEquipName = player.装备栏[slot_id];
      
      let attrLines = [];
      const changes = {};
      changes.装备栏 = { ...player.装备栏 };

      if (oldEquipName) {
        const oldDef = equipmentSystem.getDefinition(oldEquipName);
        // 卸下旧装备
        await equipmentSystem.unequipItem(playerId, slot_id, services, false); // false 表示暂不保存，稍后统一保存
        
        if (oldDef) {
          message = `成功替换了 ${oldEquipName} 为 ${equipmentName}！\n部位：${slot.name}\n`;
          // 计算属性变化
          const diffs = [];
          const allKeys = new Set([...Object.keys(def.stats), ...Object.keys(oldDef.stats)]);
          allKeys.forEach(key => {
            const newVal = def.stats[key] || 0;
            const oldVal = oldDef.stats[key] || 0;
            const diff = newVal - oldVal;
            if (diff !== 0) {
              const isRate = key.includes('率') || key.includes('伤害');
              diffs.push(`${key}${diff > 0 ? '+' : ''}${diff}${isRate ? '%' : ''}`);
            }
          });
          if (diffs.length > 0) { attrLines = diffs; message += `属性变化：${diffs.join(', ')}\n`; }
        }
      } else {
        attrLines = Object.entries(def.stats)
          .map(([key, val]) => `${key}${val > 0 ? '+' : ''}${val}${key.includes('率') || key.includes('伤害') ? '%' : ''}`);
        message += `属性增加：${attrLines.join(', ')}\n`;
      }

      // 3. 扣减背包
      const backpack = core.getModule('backpack');
      await backpack.removeItem(playerId, equipmentName, 1);

      // 4. 写入装备栏并应用属性
      changes.装备栏[slot_id] = equipmentName;
      equipmentSystem._applyStats(changes, def.stats, 1); // 应用属性到 changes 对象
      
      // 5. 保存与返回
      try {
        await services.player.modify({ playerId, changes: changes, source: 'equipment:equipItem' });
        await core.emit('equipment:equipped', playerId, equipmentName, slot_id);
      } catch (error) {
        core.log('error', `装备模块 equipItem 保存失败: ${error.message}`);
        throw error; // 重新抛出错误以便上层捕获
      }

const skills = getEquipSkills(def); if (skills.length) message += `附带技能：${skills.join(' / ')}\n`;
      
      return { 
        success: true, 
        message: message.trim(),
        attrLines,
        slotName: slot.name
      };
    },

    /**
     * 卸下装备
     */
    unequipItem: async (playerId, slot_id, services, shouldSave = true) => {
      const player = await services.player.get(playerId);
      if (!player || !player.装备栏 || !player.装备栏[slot_id]) return false;

      const equipmentName = player.装备栏[slot_id];
      const def = core.equipment.getDefinition(equipmentName);
      if (!def) return false;

      let attrLines = [];
      const changes = {};
      changes.装备栏 = { ...player.装备栏 };

      // 1. 还原属性
      equipmentSystem._applyStats(changes, def.stats, -1);

      // 2. 移除装备栏并放回背包
      changes.装备栏[slot_id] = null;
      const backpack = core.getModule('backpack');
      await backpack.addItem(playerId, equipmentName, 1);

      if (shouldSave) {
        try {
          await services.player.modify({ playerId, changes: changes, source: 'equipment:unequipItem' });
        } catch (error) {
          core.log('error', `装备模块 unequipItem 保存失败: ${error.message}`);
          throw error; // 重新抛出错误以便上层捕获
        }
      }

      await core.emit('equipment:unequipped', playerId, equipmentName, slot_id);
      return true;
    },

    /**
     * 解除封印
     */
    unsealItem: async (playerId, equipmentName, services) => {
      const def = core.equipment.getDefinition(equipmentName);
      if (!def || !def.sealed) return { success: false, message: '该物品不是封印装备。' };

      const player = await services.player.get(playerId);
      if (!player || !player.背包 || !player.背包[equipmentName]) {
        return { success: false, message: '你的背包中没有这件封印装备。' };
      }

      // 检查材料
      const backpack = core.getModule('backpack');
      for (const mat of (def.unsealMaterials || [])) {
        if (!player.背包[mat.itemName] || player.背包[mat.itemName] < mat.quantity) {
          return { success: false, message: `解封材料不足，缺少 ${mat.itemName} x${mat.quantity}。` };
        }
      }

      // 扣除材料
      for (const mat of (def.unsealMaterials || [])) {
        await backpack.removeItem(playerId, mat.itemName, mat.quantity);
      }

      // 解封装备 (这里直接修改 def，但实际上应该修改玩家背包里的物品实例)
      // 为了简化，我们直接修改内存中的定义，这会影响所有玩家
      // 更严谨的做法是在玩家背包中存储物品的完整状态，包括是否已解封
      // 或者为每个玩家维护一个已解封装备的列表
      // 目前沿用现有逻辑，直接修改 def 属性。
      def.sealed = false;
      core.updateState(`equipmentDefinitions.${equipmentName}.sealed`, false);

      await core.emit('equipment:unsealed', playerId, equipmentName);
      return { success: true, message: `成功解封了 ${equipmentName}！现在可以装备了。` };
    },

    _applyStats: (targetObj, stats, multiplier) => {
      Object.entries(stats).forEach(([key, val]) => {
        const change = val * multiplier;
        targetObj[key] = (targetObj[key] || 0) + change;
        
        // 同步增加上限属性
        if (key === '生命') {
          targetObj.生命上限 = (targetObj.生命上限 || 0) + change;
        } else if (key === '魔法') {
          targetObj.魔法上限 = (targetObj.魔法上限 || 0) + change;
        }
      });
    },

    _checkAndApplySetBonus: async (playerId, setName, services) => {
      const setDef = setDefinitions.get(setName);
      if (!setDef) return false;

      const player = await services.player.get(playerId);
      if (!player || !player.装备栏) return false;

      // 检查是否集齐
      const equippedNames = Object.values(player.装备栏);
      const isComplete = setDef.components.every(itemName => equippedNames.includes(itemName));

      if (isComplete) {
        // 如果已集齐且尚未应用过效果
        if (!player._activeSets) player._activeSets = [];
        if (!player._activeSets.includes(setName)) {
          const newChanges = { ...player };
          for (const tier of setDef.effects.tiers) {
            if (equippedNames.filter(e => setDef.components.includes(e)).length >= tier.requiredCount) {
              for (const effect of tier.effects) {
                equipmentSystem._applyStats(newChanges, { [effect.attr]: effect.value }, 1);
              }
            }
          }
          newChanges._activeSets.push(setName);
          await services.player.modify({ playerId, changes: newChanges, source: 'equipment:applySetBonus' });
          return true;
        }
      }
      return false;
    },

    _checkAndRemoveSetBonus: async (playerId, setName, services) => {
      const setDef = setDefinitions.get(setName);
      if (!setDef) return;

      const player = await services.player.get(playerId);
      if (!player || !player._activeSets || !player._activeSets.includes(setName) || !player.装备栏) return;

      // 检查是否不再齐全
      const equippedNames = Object.values(player.装备栏);
      const isComplete = setDef.components.every(itemName => equippedNames.includes(itemName));

      if (!isComplete) {
        const newChanges = { ...player };
        for (const tier of setDef.effects.tiers) {
          if (equippedNames.filter(e => setDef.components.includes(e)).length >= tier.requiredCount) {
            for (const effect of tier.effects) {
              equipmentSystem._applyStats(newChanges, { [effect.attr]: effect.value }, -1);
            }
          }
        }
        newChanges._activeSets = newChanges._activeSets.filter(s => s !== setName);
        await services.player.modify({ playerId, changes: newChanges, source: 'equipment:removeSetBonus' });
      }
    }
  };

  const doors = [
    { default_triggers: ['查看装备', '装备栏'], logical_name: 'equipment:view', description: '查看已装备物品' },
    { default_triggers: ['装备', '穿戴'], logical_name: 'equipment:equip', description: '穿戴装备' },
    { default_triggers: ['卸下', '脱下'], logical_name: 'equipment:unequip', description: '卸下已穿戴的装备' },
    { default_triggers: ['解封'], logical_name: 'equipment:unseal', description: '解除装备的封印' },
    { default_triggers: ['查看详情', '装备详情'], logical_name: 'equipment:view_detail', description: '查看装备的详细信息' }
  ];

  const templates = {
    'equipment:view.slots': { text: '你的装备栏：\n{if 装备列表}{装备列表}{else}暂无装备{/if}', markdown: '你的装备栏：\n{if 装备列表}{装备列表}{else}暂无装备{/if}' },
    'equipment:view.empty': { text: '你当前没有任何装备。', markdown: '你当前没有任何装备。' },
    'equipment:equip.success': { text: '装备 {装备名} 成功！\n部位：{slotName}\n{if 属性变化}属性变化：{属性变化}\n{/if}{if 套装信息}\n🌟 套装状态：\n{套装信息}\n{/if}', markdown: '装备 **{装备名}** 成功！\n部位：**{slotName}**\n{if 属性变化}**属性变化：**{属性变化}\n{/if}{if 套装信息}\n**🌟 套装状态：**\n{套装信息}\n{/if}' },
    'equipment:equip.no_definition': { text: '未找到该装备的定义。', markdown: '未找到该装备的定义。' },
    'equipment:equip.not_equipment': { text: '该物品不是装备。', markdown: '该物品不是装备。' },
    'equipment:equip.sealed': { text: '封印物未解封无法装备。', markdown: '封印物未解封无法装备。' },
    'equipment:equip.level_insufficient': { text: '等级不足，需要达到 {level_required} 级。', markdown: '等级不足，需要达到 **{level_required}** 级。' },
    'equipment:equip.class_mismatch': { text: '职业不符，仅限 {class_required} 使用。', markdown: '职业不符，仅限 **{class_required}** 使用。' },
    'equipment:equip.no_item': { text: '你的背包中没有这件装备。', markdown: '你的背包中没有这件装备。' },
    'equipment:equip.invalid_slot': { text: '无效的装备部位。', markdown: '无效的装备部位。' },
    'equipment:unequip.success': { 
      text: '👕 卸下成功：{装备名}\n\n[if:属性变化]✨ 属性变化：\n{属性变化}\n[/if]\n[if:套装信息]\n🌟 套装状态：\n{套装信息}\n[/if]',
      markdown: '👕 **卸下成功**\n> 你卸下了 **{装备名}**\n\n[if:属性变化]**✨ 属性变化**\n{属性变化}\n[/if]\n[if:套装信息]**🌟 套装状态**\n{套装信息}\n[/if]' 
    },
    'equipment:unequip.not_equipped': { text: '你没有装备 {target}。', markdown: '你没有装备 **{target}**。' },
    'equipment:unequip.fail_unknown': { text: '卸下 {装备名} 失败，未知错误。', markdown: '卸下 **{装备名}** 失败，未知错误。' },
    'equipment:unseal.success': { text: '成功解封了 {装备名}！现在可以装备了。', markdown: '成功解封了 **{装备名}**！现在可以装备了。' },
    'equipment:unseal.fail': { text: '该物品不是封印装备。', markdown: '该物品不是封印装备。' },
    'equipment:view_detail.no_target': { text: '请指定要查看的装备名。', markdown: '请指定要查看的装备名。' },
    'equipment:view_detail.not_found': { text: '装备 {装备名} 不存在。', markdown: '装备 **{装备名}** 不存在。' },
    'equipment:view_detail.success': {
      text: '【[装备名]】\n部位：[装备所属部位]\n介绍：[装备介绍]\n限制：[装备等级限制]级{if 装备职业途径限制} / [装备职业途径限制]{/if}\n属性：[装备提供基础属性]\n技能：[装备附带技能]\n状态：[装备封印状态]\n套装：[装备所属套装]',
      markdown: '【**[装备名]**】\n部位：[装备所属部位]\n介绍：[装备介绍]\n限制：[装备等级限制]级{if 装备职业途径限制} / [装备职业途径限制]{/if}\n属性：[装备提供基础属性]\n技能：[装备附带技能]\n状态：[装备封印状态]\n套装：[装备所属套装]'
    }
  };

  const handlers = {
    'equipment:view': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

        const rawArg = args && args[0];
        const isPageArg = rawArg !== undefined && /^\d+$/.test(String(rawArg));
        if (rawArg && !isPageArg) {
            return await handlers['equipment:view_detail'](request);
        }

        // 查看装备栏（分页）
        const slots = equipmentSystem.getAllSlots();
        const equippedList = [];
        for (const slot of slots) {
            const equipped = player.装备栏 ? player.装备栏[slot.id] : null;
            if (equipped) equippedList.push({ 槽: slot.name, 名: equipped });
        }

        if (equippedList.length === 0) {
            return { status: 'empty', data: {}, templateKey: 'equipment:view.empty' };
        }

        const 页码 = Math.max(1, parseInt(args && args[0]) || 1);
        const 每页 = 5;
        const 总页数 = Math.ceil(equippedList.length / 每页);
        const 实际页码 = Math.min(页码, 总页数);
        const start = (实际页码 - 1) * 每页;
        const pageItems = equippedList.slice(start, start + 每页);

        // 用 ui.btn.unequip 按钮（卸下 {装备名}）
        const mode = (core.state.settings?.message_mode == 2) ? 'md' : 'text';
        let btnTpl = '';
        try {
            // 用背包同款 getUiTpl 风格：从 message_templates 读，注意 md 用 markdown_content
            const row = await core.db.getMessageTemplate('ui', 'btn.unequip.' + mode);
            if (row) {
                const raw = (mode === 'md') ? (row.markdown_content || row.text_content) : (row.text_content || row.markdown_content);
                btnTpl = raw || '';
            }
        } catch (e) {}

        const data = { 页码: 实际页码, 总页数 };
        for (let i = 0; i < 每页; i++) {
            if (i < pageItems.length) {
                const it = pageItems[i];
                // 走通用渲染：用户模板里可用任意 data 字段
                const _btnData = { itemName: it.名, name: it.名, itemNameEnc: encodeURIComponent(it.名), slot: it.槽 };
                const btn = btnTpl ? await core.renderUiTpl(btnTpl, _btnData, playerId) : '';
                data['列表' + (i + 1)] = { 槽: it.槽, 名: it.名, 按钮: btn };
            } else {
                data['列表' + (i + 1)] = null;
            }
        }

        // 翻页按钮走 UI 模板（2026-09-17）：与「卸下」按钮同一套机制，编辑器里可改
        const readPageTpl = async (baseKey) => {
            try {
                const row2 = await core.db.getMessageTemplate('ui', baseKey + '.' + mode);
                if (!row2) return '';
                return ((mode === 'md') ? (row2.markdown_content || row2.text_content) : (row2.text_content || row2.markdown_content)) || '';
            } catch (e) { return ''; }
        };
        const buildPageBtn = async (baseKey, 目标页) => {
            if (!目标页) return '';
            const tpl = await readPageTpl(baseKey);
            if (!tpl) return '';
            const 命令 = '装备栏 ' + 目标页;
            return await core.renderUiTpl(tpl, {
                页: 目标页, 总页数, 命令,
                cmd: 命令, cmdEnc: encodeURIComponent(命令),
                itemNameEnc: encodeURIComponent(命令),
            }, playerId);
        };
        data.上一页 = await buildPageBtn('ui.btn.prev', 实际页码 > 1 ? 实际页码 - 1 : 0);
        data.下一页 = await buildPageBtn('ui.btn.next', 实际页码 < 总页数 ? 实际页码 + 1 : 0);

        // 查询已激活套装
        let 套装信息 = '';
        try {
            const setMod = core.getModule('equipmentSet');
            if (setMod && typeof setMod.getPlayerActiveSets === 'function') {
                const sets = await setMod.getPlayerActiveSets(playerId, services);
                套装信息 = sets.map(s => `【${s.setName}】${s.count}/${s.total} 件\n${s.tierDescs.join('\n')}`).join('\n\n');
            }
        } catch (e) { core.log('warn', '装备栏查套装失败: ' + e.message); }
        data.套装信息 = 套装信息;

        return { status: 'success', data, templateKey: 'equipment:view.slots' };
    },

    'equipment:equip': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

        const equipmentName = args[0];
        if (!equipmentName) {
            // 如果没有参数，回退到查看装备栏
            return await handlers['equipment:view'](request);
        }

        const def = await equipmentSystem.getDefinitionAsync(equipmentName);
        if (!def) {
            return { status: 'no_definition', data: {}, templateKey: 'equipment:equip.no_definition' };
        }
        const res = await equipmentSystem.equipItem(playerId, equipmentName, services);

        // 主动触发套装重算，然后查激活列表 + 套装变化
        let 套装信息 = '';
        let 套装变化 = '';
        if (res.success) {
            try {
                const setMod = core.getModule('equipmentSet');
                if (setMod && typeof setMod.getPlayerActiveSets === 'function') {
                    if (typeof setMod.checkAndApplySetEffects === 'function') {
                        await setMod.checkAndApplySetEffects(playerId, core, services);
                    }
                    const sets = await setMod.getPlayerActiveSets(playerId, services);
                    套装信息 = sets.map(s => `【${s.setName}】${s.count}/${s.total} 件\n${s.tierDescs.join('\n')}`).join('\n\n');
                }
                if (setMod && typeof setMod.getSetSnapshot === 'function') {
                    const snap = await setMod.getSetSnapshot(playerId, services);
                    const newTiers = [];
                    for (const s of snap) {
                        if (s.activeTiers.length > 0) {
                            newTiers.push(`✅ 【${s.setName}】${s.count}/${s.total} 件，激活 ${s.activeTiers.map(t => t + '件套').join('、')}`);
                        }
                    }
                    套装变化 = newTiers.join('\n');
                }
            } catch (e) { core.log('warn', '查套装信息失败: ' + e.message); }
        }

        const 属性变化 = (res.attrLines && res.attrLines.length) ? res.attrLines.join('\n') : '';
        return {
            status: res.success ? 'success' : res.reason,
            data: {
                result: res,
                item: def,
                装备名: equipmentName,
                slotName: res.slotName || '',
                属性变化,
                套装信息,
                level_required: def.level_required || 0,
                class_required: def.class_required || ''
            },
            templateKey: res.success ? 'equipment:equip.success' : `equipment:equip.${res.reason}`
        };
    },

    'equipment:unequip': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

        const target = args[0];
        if (!target) return '请指定要卸下的装备名或部位。';

        const slots = equipmentSystem.getAllSlots();
        let slotId = null;
        let equipmentName = null;

        const foundSlot = slots.find(s => s.name === target || s.id === target);
        if (foundSlot) {
            slotId = foundSlot.id;
            equipmentName = player.装备栏 ? player.装备栏[slotId] : null;
        } else {
            for (const slot of slots) {
                if (player.装备栏 && player.装备栏[slot.id] === target) {
                    slotId = slot.id;
                    equipmentName = target;
                    break;
                }
            }
        }

        if (!slotId || !equipmentName) return { status: 'fail_not_equipped', data: { target }, templateKey: 'equipment:unequip.not_equipped' };

        // 记下卸下前属性 + 套装快照（用于算变化）
        const defBefore = await equipmentSystem.getDefinitionAsync(equipmentName);
        const statsBefore = {};
        if (defBefore && defBefore.stats) {
            for (const [k, v] of Object.entries(defBefore.stats)) statsBefore[k] = v;
        }
        let setsBefore = [];
        try {
            const setMod0 = core.getModule('equipmentSet');
            if (setMod0 && typeof setMod0.getSetSnapshot === 'function') {
                setsBefore = await setMod0.getSetSnapshot(playerId, services);
            }
        } catch (e) {}

        const success = await equipmentSystem.unequipItem(playerId, slotId, services);
        if (!success) {
            return { status: 'fail_unknown', data: { 装备名: equipmentName }, templateKey: 'equipment:unequip.fail_unknown' };
        }

        // 主动重算套装
        let setsAfter = [];
        try {
            const setMod = core.getModule('equipmentSet');
            if (setMod && typeof setMod.checkAndApplySetEffects === 'function') {
                await setMod.checkAndApplySetEffects(playerId, core, services);
            }
            if (setMod && typeof setMod.getSetSnapshot === 'function') {
                setsAfter = await setMod.getSetSnapshot(playerId, services);
            }
        } catch (e) { core.log('warn', '卸下重算套装失败: ' + e.message); }

        // 算属性变化
        const diffs = [];
        for (const [k, v] of Object.entries(statsBefore)) {
            const isRate = k.includes('率') || k.includes('伤害');
            diffs.push(`${k}-${v}${isRate ? '%' : ''}`);
        }
        const 属性变化 = diffs.length ? diffs.join('\n') : '';

        // 算套装变化（对比前后）
        const 套装变化 = [];
        for (const b of setsBefore) {
            const a = setsAfter.find(x => x.setName === b.setName);
            if (!a) {
                套装变化.push(`❌ 【${b.setName}】已全部卸下（${b.count}件 → 0）`);
            } else if (a.count < b.count) {
                const lostTiers = b.activeTiers.filter(t => !a.activeTiers.includes(t));
                if (lostTiers.length > 0) {
                    套装变化.push(`⚠️ 【${b.setName}】${b.count}件 → ${a.count}件，失效层级：${lostTiers.map(t => t + '件套').join('、')}`);
                } else {
                    套装变化.push(`📉 【${b.setName}】${b.count}件 → ${a.count}件`);
                }
            }
        }
        // 如果卸下后仍有激活的套装，也展示当前状态
        let 当前套装 = '';
        try {
            const setMod = core.getModule('equipmentSet');
            if (setMod && typeof setMod.getPlayerActiveSets === 'function') {
                const sets = await setMod.getPlayerActiveSets(playerId, services);
                当前套装 = sets.map(s => `【${s.setName}】${s.count}/${s.total} 件\n${s.tierDescs.join('\n')}`).join('\n\n');
            }
        } catch (e) {}

        return {
            status: 'success',
            data: { 装备名: equipmentName, 属性变化, 套装变化: 套装变化.join('\n'), 套装信息: 当前套装 },
            templateKey: 'equipment:unequip.success'
        };
    },

    'equipment:unseal': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };

        const equipmentName = args[0];
        if (!equipmentName) return '请指定要解封的装备名。';

        const res = await equipmentSystem.unsealItem(playerId, equipmentName, services);
        return { status: res.success ? 'success' : 'fail', data: { result: res, 装备名: equipmentName }, templateKey: res.success ? 'equipment:unseal.success' : 'equipment:unseal.fail' };
    },

    'equipment:view_detail': async (request) => {
        const { playerId, args, core, services } = request;
        const equipmentName = args[0];
        if (!equipmentName) return { status: 'fail_no_target', data: {}, templateKey: 'equipment:view_detail.no_target' };

        const def = await equipmentSystem.getDefinitionAsync(equipmentName);
        if (!def) {
            return { status: 'not_found', data: { 装备名: equipmentName }, templateKey: 'equipment:view_detail.not_found' };
        }

        return { status: 'success', data: { item: def }, templateKey: 'equipment:view_detail.success' };
    }
  };

  core.registerModule('equipment', { doors, templates, handlers });

  // 执行初始化
  await equipmentSystem.init();

  core.equipment = equipmentSystem;
  core.log('info', '装备系统模块加载完成。');

  return {
    moduleName: 'equipment',
    ...equipmentSystem
  };
}

equipmentModule.moduleName = 'equipment';
equipmentModule.dependencies = ['database', 'player', 'backpack', 'item'];

module.exports = equipmentModule;