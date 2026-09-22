const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * 数据库模块 - 为核心引擎提供持久化支持
 */
async function databaseModule(core) {
  const config = core.config.database || {};
  const dbType = config.dbType || 'sqlite';
  const defaultDbPath = path.join(__dirname, '..', 'data', 'game.db');
  const dbPath = config.dbPath || defaultDbPath;

  // 确保目录存在
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  core.log('info', `正在初始化数据库模块 (类型: ${dbType}, 路径: ${dbPath})...`);

  if (dbType !== 'sqlite') {
    throw new Error(`暂不支持的数据库类型: ${dbType}`);
  }

  try {
    // 建立异步连接
    const db = await open({ filename: dbPath, driver: sqlite3.Database });

    // 连接玩家数据数据库
    const playerDbPath = path.join(__dirname, '..', 'data', 'players.db');
    const playerDb = await open({ filename: playerDbPath, driver: sqlite3.Database });
    db.playerDb = playerDb; // 挂载到主 db 对象上

    // 启用 WAL 模式以减少数据库锁冲突 (SQLITE_BUSY)
    await db.run('PRAGMA journal_mode = WAL');
    // 启用 NORMAL 同步模式以提高写入性能
    await db.run('PRAGMA synchronous = NORMAL');
    await db.run('PRAGMA wal_autocheckpoint = 1000;');

    // players.db 的 PRAGMA
    await playerDb.run('PRAGMA journal_mode = WAL;');
    await playerDb.run('PRAGMA synchronous = NORMAL;');
    await playerDb.run('PRAGMA foreign_keys = ON;'); // 启用外键约束

    // 扩展数据库连接对象的方法
    

    /**
     * 获取玩家数据
     * @param {string} playerId 玩家 ID
     */
    db.getPlayer = async (playerId) => {
      // 从 players 表读基础信息
      const base = await db.playerDb.get('SELECT * FROM players WHERE id = ?', [playerId]);
      if (!base) return null;
      
      // 读属性
      const attrs = await db.playerDb.get('SELECT * FROM player_attributes WHERE player_id = ?', [playerId]) || {};
      
      // 读货币
      const currencies = await db.playerDb.all('SELECT currency_type, amount FROM player_currency WHERE player_id = ?', [playerId]);
      
      // 读背包
      const backpackRows = await db.playerDb.all('SELECT item_name, quantity FROM player_backpack WHERE player_id = ?', [playerId]);
      
      // 读装备栏
      const equipRows = await db.playerDb.all('SELECT slot_id, equipment_name FROM player_equipment WHERE player_id = ?', [playerId]);
      
      // 读技能
      const skillRows = await db.playerDb.all('SELECT skill_name FROM player_skills WHERE player_id = ?', [playerId]);
      
      // 读任务
      const questRows = await db.playerDb.all('SELECT * FROM player_quests WHERE player_id = ?', [playerId]);
      
      // 读 buff
      const buffRows = await db.playerDb.all('SELECT * FROM player_buffs WHERE player_id = ?', [playerId]);
      
      // 组装成业务对象
      const result = {
        id: base.id,
        昵称: base.nickname,
        性别: base.gender,
        QQ号: base.qq,
        等级: base.level,
        经验: base.exp,
        职业途径: base.profession_path,
        职业序列: base.profession_sequence,
        初始地图: base.initial_map,
        当前地图: base.current_map,
        状态: base.state,
        死亡时间: base.death_time,
        注册时间: base.registered_at,
        生命: attrs.hp,
        生命上限: attrs.hp_max,
        魔法: attrs.mp,
        魔法上限: attrs.mp_max,
        攻击: attrs.attack,
        防御: attrs.defense,
        暴击率: attrs.crit_rate,
        暴击伤害: attrs.crit_damage,
        闪避率: attrs.dodge_rate,
        货币1: 0, 货币2: 0, 货币3: 0, 特殊货币: 0,
        背包: {},
        装备栏: {},
        技能: [],
        任务: {},
        buff列表: []
      };
      
      // 货币填充
      currencies.forEach(c => { result[c.currency_type] = c.amount; });
      
      // 背包填充
      backpackRows.forEach(r => { result.背包[r.item_name] = r.quantity; });
      
      // 装备栏填充
      equipRows.forEach(r => { result.装备栏[r.slot_id] = r.equipment_name; });
      
      // 技能填充
      result.技能 = skillRows.map(r => r.skill_name);
      
      result.任务 = questRows.map(r => ({
        name: r.quest_name,
        status: r.status,
        completed: r.status === 'completed',
        objectives_progress: r.progress ? JSON.parse(r.progress) : {},
        accepted_at: r.accepted_at,
        completed_at: r.completed_at
      }));
      
      // buff 填充
      result.buff列表 = buffRows.map(r => ({
        name: r.buff_name,
        multiplier: r.multiplier,
        expires_at: r.expires_at
      }));
      

      // 恢复模块临时字段（_activeSetTiers 等）
      const _metaRow = await db.playerDb.get('SELECT meta_json FROM players WHERE id = ?', [playerId]);
      if (_metaRow && _metaRow.meta_json) {
        try {
          const meta = JSON.parse(_metaRow.meta_json);
          for (const k in meta) result[k] = meta[k];
        } catch (e) {}
      }

      return result;
    };

    // 玩家保存锁：按 playerId 串行化，防止并发 DELETE+INSERT 冲突 
    const saveLocks = new Map();

    function withPlayerLock(playerId, task) {
      const prev = saveLocks.get(playerId) || Promise.resolve();
      const next = prev.then(task, task);
      saveLocks.set(playerId, next.catch(() => {}));  // 防止错误阻塞后续 
      return next;
    }

    /**
     * 保存或更新玩家数据
     * @param {Object} player 玩家数据对象
     */
    db.savePlayer = async (player) => {
      return withPlayerLock(player.id, () => db._savePlayerUnsafe(player));
    };

    db._savePlayerUnsafe = async (player) => {
      const id = player.id;
      const now = new Date().toISOString();
      
      // 主表
      await db.playerDb.run(`
        INSERT INTO players (id, nickname, gender, qq, level, exp, profession_path, profession_sequence, initial_map, current_map, state, death_time, registered_at, updated_at, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          nickname=excluded.nickname, gender=excluded.gender, qq=excluded.qq,
          level=excluded.level, exp=excluded.exp,
          profession_path=excluded.profession_path, profession_sequence=excluded.profession_sequence,
          initial_map=excluded.initial_map, current_map=excluded.current_map,
          state=excluded.state, death_time=excluded.death_time,
          updated_at=excluded.updated_at, meta_json=excluded.meta_json
      `, [id, player.昵称, player.性别, player.QQ号, player.等级, player.经验,
          player.职业途径, player.职业序列, player.初始地图, player.当前地图,
          player.状态 || 'alive', player.死亡时间 || null,
          player.注册时间 || now, now,
          (() => { const m = {}; for (const k in player) if (k.startsWith('_')) m[k] = player[k]; return Object.keys(m).length ? JSON.stringify(m) : null; })()]);
      
      // 属性表
      await db.playerDb.run(`
        INSERT INTO player_attributes (player_id, hp, hp_max, mp, mp_max, attack, defense, crit_rate, crit_damage, dodge_rate, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(player_id) DO UPDATE SET
          hp=excluded.hp, hp_max=excluded.hp_max, mp=excluded.mp, mp_max=excluded.mp_max,
          attack=excluded.attack, defense=excluded.defense,
          crit_rate=excluded.crit_rate, crit_damage=excluded.crit_damage, dodge_rate=excluded.dodge_rate,
          updated_at=excluded.updated_at
      `, [id, player.生命, player.生命上限, player.魔法, player.魔法上限,
          player.攻击, player.防御, player.暴击率, player.暴击伤害, player.闪避率, now]);
      
      // 货币表（2026-09-20 改：原来写的是「先 DELETE 全部、再逐条 INSERT」，两条语句之间有 await ——
      // 这期间任何一次读都会看到**空的钱包/背包/装备栏**。实测：装备命令回了成功、写入序列里装备栏也都对，
      // 但紧接着的读拿到 {}（test_full 的「装备栏已更新」因此 ~1/3 概率红）。
      // 现在统一改成「先按唯一键 upsert、再删掉这次没写的」：读最多看到"多一条旧记录"，绝不会看到空。
      // 下面背包 / 装备栏 / 技能 / 任务同样处理。）
      const curFields = ['货币1', '货币2', '货币3', '特殊货币'].filter((f) => (player[f] || 0) !== 0);
      for (const field of curFields) {
        await db.playerDb.run(
          'INSERT INTO player_currency (player_id, currency_type, amount, updated_at) VALUES (?,?,?,?) ' +
          'ON CONFLICT(player_id, currency_type) DO UPDATE SET amount = excluded.amount, updated_at = excluded.updated_at',
          [id, field, player[field], now]);
      }
      await db.playerDb.run(
        curFields.length
          ? ('DELETE FROM player_currency WHERE player_id = ? AND currency_type NOT IN (' + curFields.map(() => '?').join(',') + ')')
          : 'DELETE FROM player_currency WHERE player_id = ?',
        curFields.length ? [id].concat(curFields) : [id]);
      
      // 背包表：先 upsert、再删多余（理由见上面货币表那段）
      const bagEntries = Object.entries(player.背包 || {}).filter((e) => e[1] > 0);
      for (const [itemName, quantity] of bagEntries) {
        await db.playerDb.run(
          'INSERT INTO player_backpack (player_id, item_name, quantity, updated_at) VALUES (?,?,?,?) ' +
          'ON CONFLICT(player_id, item_name) DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at',
          [id, itemName, quantity, now]);
      }
      await db.playerDb.run(
        bagEntries.length
          ? ('DELETE FROM player_backpack WHERE player_id = ? AND item_name NOT IN (' + bagEntries.map(() => '?').join(',') + ')')
          : 'DELETE FROM player_backpack WHERE player_id = ?',
        bagEntries.length ? [id].concat(bagEntries.map((e) => e[0])) : [id]);
      
      // 装备栏：先 upsert、再删多余（这一张就是被 test_full 抓到的那处）
      const eqEntries = Object.entries(player.装备栏 || {}).filter((e) => !!e[1]);
      for (const [slotId, equipName] of eqEntries) {
        await db.playerDb.run(
          'INSERT INTO player_equipment (player_id, slot_id, equipment_name, updated_at) VALUES (?,?,?,?) ' +
          'ON CONFLICT(player_id, slot_id) DO UPDATE SET equipment_name = excluded.equipment_name, updated_at = excluded.updated_at',
          [id, slotId, equipName, now]);
      }
      await db.playerDb.run(
        eqEntries.length
          ? ('DELETE FROM player_equipment WHERE player_id = ? AND slot_id NOT IN (' + eqEntries.map(() => '?').join(',') + ')')
          : 'DELETE FROM player_equipment WHERE player_id = ?',
        eqEntries.length ? [id].concat(eqEntries.map((e) => e[0])) : [id]);
      
      // 技能：先 upsert、再删多余（已学过的 DO NOTHING —— 原来"删光再插"会把 learned_at 刷成当前时间）
      const skillNames = (player.技能 || []).filter(Boolean);
      for (const skillName of skillNames) {
        await db.playerDb.run(
          'INSERT INTO player_skills (player_id, skill_name, learned_at) VALUES (?,?,?) ON CONFLICT(player_id, skill_name) DO NOTHING',
          [id, skillName, now]);
      }
      await db.playerDb.run(
        skillNames.length
          ? ('DELETE FROM player_skills WHERE player_id = ? AND skill_name NOT IN (' + skillNames.map(() => '?').join(',') + ')')
          : 'DELETE FROM player_skills WHERE player_id = ?',
        skillNames.length ? [id].concat(skillNames) : [id]);
      
      // 任务：先 upsert、再删多余
      const taskArr = (Array.isArray(player.任务) ? player.任务 : []).filter((pq) => pq && pq.name);
      for (const pq of taskArr) {
        await db.playerDb.run(
          'INSERT INTO player_quests (player_id, quest_name, status, progress, accepted_at, completed_at) VALUES (?,?,?,?,?,?) ' +
          'ON CONFLICT(player_id, quest_name) DO UPDATE SET status = excluded.status, progress = excluded.progress, accepted_at = excluded.accepted_at, completed_at = excluded.completed_at',
          [id, pq.name, pq.status || 'active', JSON.stringify(pq.objectives_progress || pq.progress || {}), pq.accepted_at || now, pq.completed_at || null]
        );
      }
      await db.playerDb.run(
        taskArr.length
          ? ('DELETE FROM player_quests WHERE player_id = ? AND quest_name NOT IN (' + taskArr.map(() => '?').join(',') + ')')
          : 'DELETE FROM player_quests WHERE player_id = ?',
        taskArr.length ? [id].concat(taskArr.map((pq) => pq.name)) : [id]);
      // buff（这张表没有 (player_id, buff_name) 唯一键，做不了 upsert —— 暂时保持"先删后插"。
      // 它短暂为空的影响比装备栏小得多：buff 是战斗加成，不会被"装备完立刻看一眼"这种读撞上。）
      await db.playerDb.run('DELETE FROM player_buffs WHERE player_id = ?', [id]);
      for (const buff of (player.buff列表 || [])) {
        await db.playerDb.run('INSERT INTO player_buffs (player_id, buff_name, multiplier, expires_at) VALUES (?, ?, ?, ?)', [id, buff.name, buff.multiplier || 1.0, buff.expires_at]);
      }
    };

    /**
     * 获取单个别名
     * @param {string} field 别名原始字段
     */
    db.getAlias = async (field) => {
      const row = await db.get('SELECT alias FROM aliases WHERE field = ?', field);
      return row ? row.alias : undefined;
    };

    /**
     * 获取所有别名映射
     */
    db.getAllAliases = async () => {
      return await db.all('SELECT rowid AS id, field, alias, enabled FROM aliases ORDER BY rowid ASC');
    };

    /**
     * 保存或更新别名
     */
    db.saveAlias = async (field, alias, enabled = 1) => {
      const existing = await db.get('SELECT field FROM aliases WHERE field = ?', field);
      if (existing) {
        await db.run('UPDATE aliases SET alias = ?, enabled = ? WHERE field = ?', [alias, enabled ? 1 : 0, field]);
      } else {
        await db.run('INSERT INTO aliases (field, alias, enabled) VALUES (?, ?, ?)', [field, alias, enabled ? 1 : 0]);
      }
    };

    /**
     * 删除别名
     */
    db.deleteAlias = async (field) => {
      await db.run('DELETE FROM aliases WHERE field = ?', field);
    };

    /**
     * 获取单个自定义变量
     */
    db.getVariable = async (name) => {
      return await db.get('SELECT name, value, description, contexts FROM variables WHERE name = ?', name);
    };

    /**
     * 获取所有自定义变量
     */
    db.getAllVariables = async () => {
      return await db.all('SELECT rowid AS id, name, value, description, contexts, updated_at FROM variables ORDER BY rowid ASC');
    };

    /**
     * 保存或更新自定义变量
     */
    db.saveVariable = async (name, value, description = '', contexts = '') => {
      const now = new Date().toISOString();
      const existing = await db.get('SELECT name FROM variables WHERE name = ?', name);
      if (existing) {
        await db.run(
          'UPDATE variables SET value = ?, description = ?, contexts = ?, updated_at = ? WHERE name = ?',
          [value, description, contexts, now, name],
        );
      } else {
        await db.run(
          'INSERT INTO variables (name, value, description, contexts, updated_at) VALUES (?, ?, ?, ?, ?)',
          [name, value, description, contexts, now],
        );
      }
    };

    /**
     * 删除自定义变量
     */
    db.deleteVariable = async (name) => {
      await db.run('DELETE FROM variables WHERE name = ?', name);
    };

    /**
     * 获取所有装备部位定义
     */
    db.getAllSlots = async () => {
      return await db.all('SELECT id, name, description FROM equipment_slots ORDER BY rowid ASC');
    };

    /**
     * 保存或更新装备部位
     */
    db.saveSlot = async (id, name, description = '') => {
      const existing = await db.get('SELECT id FROM equipment_slots WHERE id = ?', id);
      if (existing) {
        await db.run(
          'UPDATE equipment_slots SET name = ?, description = ? WHERE id = ?',
          [name, description, id],
        );
      } else {
        await db.run(
          'INSERT INTO equipment_slots (id, name, description) VALUES (?, ?, ?)',
          [id, name, description],
        );
      }
    };

    /**
     * 删除装备部位
     */
    db.deleteSlot = async (id) => {
      await db.run('DELETE FROM equipment_slots WHERE id = ?', id);
    };

    // --- 编辑器相关辅助方法 ---

    // 1. 编辑器设置 (editor_settings)
    db.getEditorSetting = async (key) => {
      const row = await db.get('SELECT value FROM editor_settings WHERE key = ?', key);
      if (!row) return undefined;
      try { return JSON.parse(row.value); } catch (e) { return row.value; }
    };
    db.setEditorSetting = async (key, value) => {
      const val = typeof value === 'string' ? value : JSON.stringify(value);
      const now = new Date().toISOString();
      const existing = await db.get('SELECT key FROM editor_settings WHERE key = ?', key);

      if (existing) {
        await db.run('UPDATE editor_settings SET value = ?, updated_at = ? WHERE key = ?', [val, now, key]);
      } else {
        await db.run('INSERT INTO editor_settings (key, value, updated_at) VALUES (?, ?, ?)', [key, val, now]);
      }
    };
    db.getAllEditorSettings = async () => {
      const rows = await db.all('SELECT key, value FROM editor_settings ORDER BY rowid ASC');
      const res = {};
      for (const r of rows) {
        try { res[r.key] = JSON.parse(r.value); } catch (e) { res[r.key] = r.value; }
      }
      return res;
    };

    /**
     * 获取所有玩家数据
     */
    db.getAllPlayers = async () => {
      const rows = await db.playerDb.all('SELECT id FROM players');
      const players = [];
      for (const row of rows) {
        try {
          const p = await db.getPlayer(row.id);
          if (p) players.push(p);
        } catch (e) {
          core.log('error', `[db.getAllPlayers] ???? ${row.id} ??: ${e.message}`);
          players.push({ id: row.id });
        }
      }
      return players;
    };

    db.deletePlayer = async (playerId) => {
      const childTables = ['player_backpack','player_currency','player_attributes','player_equipment','player_skills','player_quests','player_buffs'];
      for (const t of childTables) {
        try { await db.playerDb.run(`DELETE FROM ${t} WHERE player_id = ?`, [playerId]); } catch (e) {}
      }
      await db.playerDb.run('DELETE FROM players WHERE id = ?', [playerId]);
    };

    // 2. 消息模板 (message_templates)
    db.getMessageTemplate = async (room, templateKey) => await db.get('SELECT id, room, template_key, text_content, markdown_content FROM message_templates WHERE room = ? AND template_key = ?', room, templateKey);
    db.setMessageTemplate = async (id, room, templateKey, textContent, markdownContent) => {
      const now = new Date().toISOString();
      const existing = await db.get('SELECT id FROM message_templates WHERE room = ? AND template_key = ?', room, templateKey);
      if (existing) {
        await db.run(
          'UPDATE message_templates SET text_content = ?, markdown_content = ?, updated_at = ? WHERE room = ? AND template_key = ?', 
          [textContent, markdownContent, now, room, templateKey],
        );
      } else {
        await db.run(
          'INSERT INTO message_templates (id, room, template_key, text_content, markdown_content, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 
          [id, room, templateKey, textContent, markdownContent, now],
        );
      }
    };
    db.getAllMessageTemplates = async () => {
      const rows = await db.all('SELECT id, room, template_key, text_content, markdown_content FROM message_templates ORDER BY updated_at DESC');
      return rows.map(r => ({ id: r.id, room: r.room, templateKey: r.template_key, textContent: r.text_content, markdownContent: r.markdown_content }));
    };
    db.deleteMessageTemplate = async (id) => await db.run('DELETE FROM message_templates WHERE id = ?', id);

    db.deleteEditorSetting = async (key) => await db.run('DELETE FROM editor_settings WHERE key = ?', key);

    db.getRawEditorSetting = async (key) => {
      const row = await db.get('SELECT value FROM editor_settings WHERE key = ?', key);
      return row ? row.value : undefined;
    };

    // 3. 自定义指令 (custom_commands)
    db.getCustomCommand = async (trigger) => {
      const row = await db.get('SELECT id, trigger, aliases, room, logical_name, template_key, enabled, is_custom, description FROM custom_commands WHERE trigger = ?', trigger);
      if (row) {
        const res = { ...row };
        res.aliases = JSON.parse(row.aliases || '[]');
        return res;
      }
      return row;
    };
    db.setCustomCommand = async (data) => {
      core.log('debug', `[db.setCustomCommand] id: ${data.id}, trigger: ${data.trigger}, room: ${data.room}`);
      const now = new Date().toISOString();
      const existing = await db.get('SELECT id FROM custom_commands WHERE id = ?', data.id); // Check by ID
      if (existing) {
        await db.run(
          'UPDATE custom_commands SET trigger = ?, aliases = ?, enabled = ?, room = ?, logical_name = ?, template_key = ?, is_custom = ?, description = ?, updated_at = ? WHERE id = ?',
          [data.trigger, JSON.stringify(data.aliases || []), data.enabled ? 1 : 0, data.room || '', data.logical_name || '', data.template_key || '', data.is_custom ? 1 : 0, data.description || '', now, data.id],
        );
      } else {
        // If not existing by ID, check if a command with the same trigger already exists (for new inserts)
        const existingTrigger = await db.get('SELECT id FROM custom_commands WHERE trigger = ?', data.trigger);
        if (existingTrigger) {
            // If trigger exists, update that entry
            await db.run(
                'UPDATE custom_commands SET aliases = ?, enabled = ?, room = ?, logical_name = ?, template_key = ?, is_custom = ?, description = ?, updated_at = ? WHERE trigger = ?',
                [JSON.stringify(data.aliases || []), data.enabled ? 1 : 0, data.room || '', data.logical_name || '', data.template_key || '', data.is_custom ? 1 : 0, data.description || '', now, data.trigger],
            );
        } else {
            // New insert
            await db.run(
                'INSERT INTO custom_commands (id, trigger, aliases, enabled, room, logical_name, template_key, is_custom, description, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [data.id || crypto.randomUUID(), data.trigger, JSON.stringify(data.aliases || []), data.enabled ? 1 : 0, data.room || '', data.logical_name || '', data.template_key || '', data.is_custom ? 1 : 0, data.description || '', now],
            );
        }
      }
    };
    db.getAllCustomCommands = async () => {
      const rows = await db.all('SELECT id, trigger, aliases, room, logical_name, template_key, enabled, is_custom, description FROM custom_commands ORDER BY updated_at DESC');
      return rows.map(r => ({ ...r, aliases: JSON.parse(r.aliases || '[]') }));
    };
    db.deleteCustomCommand = async (trigger) => await db.run('DELETE FROM custom_commands WHERE trigger = ?', trigger);

    // 4. 地图 (maps)
    db.getAllMaps = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM maps ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        monsters: JSON.parse(r.monsters || '[]'),
        npcs: JSON.parse(r.npcs || '[]'),
        items: JSON.parse(r.items || '[]'),
        connections: JSON.parse(r.connections || '{}')
        // x / y（地图坐标）2026-09-20 起彻底废弃：库列已删，这里也不再对外补 0
      }));
    };
    const __normalizeShopItems = (items) => {
      if (typeof items === 'string') {
        try { items = JSON.parse(items); } catch (e) { items = []; }
      }
      if (!Array.isArray(items)) items = [];
      return JSON.stringify(items);
    };
    db.saveMap = async (name, data) => {
      const now = new Date().toISOString();
      const targetId = data.id || data.rowid;
      if (targetId) {
        await db.run(
          'UPDATE maps SET name = ?, description = ?, monsters = ?, npcs = ?, items = ?, connections = ?, updated_at = ? WHERE rowid = ?',
          [name, data.description || '', JSON.stringify(data.monsters || []), JSON.stringify(data.npcs || []), __normalizeShopItems(data.items), JSON.stringify(data.connections || {}), now, targetId],
        );
      } else {
        const existing = await db.get('SELECT rowid FROM maps WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE maps SET description = ?, monsters = ?, npcs = ?, items = ?, connections = ?, updated_at = ? WHERE name = ?',
            [data.description || '', JSON.stringify(data.monsters || []), JSON.stringify(data.npcs || []), __normalizeShopItems(data.items), JSON.stringify(data.connections || {}), now, name],
          );
        } else {
          await db.run(
            'INSERT INTO maps (name, description, monsters, npcs, items, connections, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, data.description || '', JSON.stringify(data.monsters || []), JSON.stringify(data.npcs || []), __normalizeShopItems(data.items), JSON.stringify(data.connections || {}), now],
          );
        }
      }
    };
    db.deleteMap = async (name) => {
    // 1. 删除地图本身
    await db.run('DELETE FROM maps WHERE name = ?', name);

    // 2. 清理其他地图对该地图的引用
    const otherMaps = await db.all('SELECT name, connections FROM maps');
    for (const m of otherMaps) {
      if (!m.connections) continue;
      let conns;
      try {
        conns = typeof m.connections === 'string' ? JSON.parse(m.connections) : m.connections;
      } catch (e) { continue; }

      let changed = false;
      for (const dir in conns) {
        if (conns[dir] === name) {
          conns[dir] = null;
          changed = true;
        }
      }

      if (changed) {
        await db.run('UPDATE maps SET connections = ? WHERE name = ?', [JSON.stringify(conns), m.name]);
      }
    }
    return true;
  };

    // 5. 怪物 (monsters)
    db.getAllMonsters = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM monsters ORDER BY rowid ASC');
      return rows.map(r => {
        let enrage = { enabled: false, hpThreshold: 30, multiplier: 1.5 };
        let flee = { enabled: false, hpThreshold: 20, chance: 0.5 };
        let killGrowth = { enabled: false, statIncrease: { 攻击: 0, 防御: 0 }, maxGrowthCount: 10 };
        
        // 确保布尔值正确
        const toBool = (val) => val === true || val === 'true' || val === 1 || val === '1';

        try { 
          // 兼容旧字段名 behavior_settings 和新字段名 enrage
          const enrageData = r.enrage || r.behavior_settings;
          if (enrageData && enrageData !== '{}') {
            const parsed = typeof enrageData === 'string' ? JSON.parse(enrageData) : enrageData;
            enrage = { ...enrage, ...parsed };
          }
        } catch (e) {}
        
        try { 
          if (r.flee && r.flee !== '{}') {
            const parsed = typeof r.flee === 'string' ? JSON.parse(r.flee) : r.flee;
            flee = { ...flee, ...parsed };
          }
        } catch (e) {}
        
        try { 
          // 兼容旧字段名 kill_growth 和新字段名 killGrowth
          const growthData = r.killGrowth || r.kill_growth;
          if (growthData && growthData !== '{}') {
            const parsed = typeof growthData === 'string' ? JSON.parse(growthData) : growthData;
            killGrowth = { ...killGrowth, ...parsed };
          }
        } catch (e) {}

        return {
          id: r.id,
          ...r,
          stats: JSON.parse(r.stats || '{}'),
          skills: JSON.parse(r.skills || '[]'),
          drops: JSON.parse(r.drops || '[]'),
          enrage: { ...enrage, enabled: toBool(enrage.enabled) },
          flee: { ...flee, enabled: toBool(flee.enabled) },
          killGrowth: { ...killGrowth, enabled: toBool(killGrowth.enabled) },
          aggressive: toBool(r.aggressive),
          aggressiveChance: parseFloat(r.aggressiveChance !== undefined ? r.aggressiveChance : (r.aggressive_chance !== undefined ? r.aggressive_chance : 0))
        };
      });
    };

    // 5.1 技能 (skills)
    db.getAllSkills = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM skills ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        cost: JSON.parse(r.cost || '{}')
      }));
    };

    // 5.2 职业 (professions)
    db.getAllProfessions = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM professions ORDER BY rowid ASC');
      return rows.map(p => ({
        id: p.id,
        ...p,
        growth_curve: JSON.parse(p.growth_curve || '{}'),
        default_skills: JSON.parse(p.default_skills || '[]'),
        sequences: JSON.parse(p.sequences || '[]'),
        transfer_conditions: JSON.parse(p.transfer_conditions || '{}'),
        transfer_cost: JSON.parse(p.transfer_cost || '[]')
      }));
    };
    db.saveProfession = async (name, data) => {
      const now = new Date().toISOString();
      const targetId = data.id || data.rowid;
      if (targetId) {
        await db.run(
          'UPDATE professions SET name = ?, description = ?, growth_curve = ?, default_skills = ?, sequences = ?, transfer_conditions = ?, transfer_cost = ?, updated_at = ? WHERE rowid = ?',
        name, data.description || '', JSON.stringify(data.growth_curve || {}), JSON.stringify(data.default_skills || []), JSON.stringify(data.sequences || []), JSON.stringify(data.transfer_conditions || {}), JSON.stringify(data.transfer_cost || []), now, targetId);
      } else {
        const existing = await db.get('SELECT rowid FROM professions WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE professions SET description = ?, growth_curve = ?, default_skills = ?, sequences = ?, transfer_conditions = ?, transfer_cost = ?, updated_at = ? WHERE name = ?',
          data.description || '', JSON.stringify(data.growth_curve || {}), JSON.stringify(data.default_skills || []), JSON.stringify(data.sequences || []), JSON.stringify(data.transfer_conditions || {}), JSON.stringify(data.transfer_cost || []), now, name);
        } else {
          await db.run(
            'INSERT INTO professions (name, description, growth_curve, default_skills, sequences, transfer_conditions, transfer_cost, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          name, data.description || '', JSON.stringify(data.growth_curve || {}), JSON.stringify(data.default_skills || []), JSON.stringify(data.sequences || []), JSON.stringify(data.transfer_conditions || {}), JSON.stringify(data.transfer_cost || []), now);
        }
      }
    };
    db.deleteProfession = async (name) => await db.run('DELETE FROM professions WHERE name = ?', name);

    // 5.3 任务 (quests)
    db.getAllQuests = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM quests ORDER BY rowid ASC');
      return rows.map(q => ({
        id: q.id,
        ...q,
        rewards: JSON.parse(q.rewards || '[]'),
        conditions: JSON.parse(q.conditions || '[]')
      }));
    };
    db.saveQuest = async (name, data) => {
      const now = new Date().toISOString();
      if (data.rowid) {
        await db.run(
          'UPDATE quests SET name = ?, description = ?, rewards = ?, conditions = ?, type = ?, type_value = ?, npc_name = ?, enabled = ?, updated_at = ? WHERE rowid = ?',
        name, data.description || '', JSON.stringify(data.rewards || []), JSON.stringify(data.conditions || []), data.type, data.type_value, data.npc_name || null, data.enabled ? 1 : 0, now, data.rowid);
      } else {
        const existing = await db.get('SELECT rowid FROM quests WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE quests SET description = ?, rewards = ?, conditions = ?, type = ?, type_value = ?, npc_name = ?, enabled = ?, updated_at = ? WHERE name = ?',
          data.description || '', JSON.stringify(data.rewards || []), JSON.stringify(data.conditions || []), data.type, data.type_value, data.npc_name || null, data.enabled ? 1 : 0, now, name);
        } else {
          await db.run(
            'INSERT INTO quests (name, description, rewards, conditions, type, type_value, npc_name, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, data.description || '', JSON.stringify(data.rewards || []), JSON.stringify(data.conditions || []), data.type, data.type_value, data.npc_name || null, data.enabled ? 1 : 0, now);
        }
      }
    };
    db.deleteQuest = async (name) => await db.run('DELETE FROM quests WHERE name = ?', name);
    db.saveSkill = async (name, data) => {
      if (data.rowid) {
        await db.run(
          'UPDATE skills SET name = ?, description = ?, cost = ?, effect = ?, effect_value = ?, effect_target = ?, effect_value_str = ?, target = ?, type = ?, cooldown = ?, duration = ? WHERE rowid = ?',
        name, data.description || '', 
          typeof data.cost === 'string' ? data.cost : JSON.stringify(data.cost || {}), 
          data.effect || '', data.effect_value || 0, data.effect_target || '', data.effect_value_str || '',
          data.target || '敌人', data.type || '主动', data.cooldown || 0, data.duration || 0, data.rowid
        );
      } else {
        const existing = await db.get('SELECT rowid FROM skills WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE skills SET description = ?, cost = ?, effect = ?, effect_value = ?, effect_target = ?, effect_value_str = ?, target = ?, type = ?, cooldown = ?, duration = ? WHERE name = ?',
          data.description || '', 
            typeof data.cost === 'string' ? data.cost : JSON.stringify(data.cost || {}), 
            data.effect || '', data.effect_value || 0, data.effect_target || '', data.effect_value_str || '',
            data.target || '敌人', data.type || '主动', data.cooldown || 0, data.duration || 0, name
          );
        } else {
          await db.run(
            'INSERT INTO skills (name, description, cost, effect, effect_value, effect_target, effect_value_str, target, type, cooldown, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, data.description || '', 
            typeof data.cost === 'string' ? data.cost : JSON.stringify(data.cost || {}), 
            data.effect || '', data.effect_value || 0, data.effect_target || '', data.effect_value_str || '',
            data.target || '敌人', data.type || '主动', data.cooldown || 0, data.duration || 0
          );
        }
      }
    };
    db.deleteSkill = async (name) => await db.run('DELETE FROM skills WHERE name = ?', name);

    db.saveMonster = async (name, data) => {
      const now = new Date().toISOString();
      
      const toBool = (val) => val === true || val === 'true' || val === 1 || val === '1';

      // 提取高级行为数据
      const extractBehavior = (key, defaultVal) => {
        let obj = data[key];
        
        // 如果 data[key] 是字符串 (来自某些老版本或异常)，尝试解析
        if (typeof obj === 'string') {
          try { obj = JSON.parse(obj); } catch(e) { obj = {}; }
        }

        // 如果不是对象或为空，尝试从扁平字段提取 (兼容 mon-enrage-enabled 等)
        if (!obj || typeof obj !== 'object' || Object.keys(obj).length === 0) {
          const searchKeys = [key.toLowerCase()];
          if (key.toLowerCase() === 'killgrowth') searchKeys.push('growth');
          
          const newObj = {};
          let found = false;
          
          const fieldMapping = {
            'hp': 'hpThreshold', 'hp-threshold': 'hpThreshold',
            'mult': 'multiplier', 'mult-iplier': 'multiplier',
            'atk': 'statIncrease.攻击', 'def': 'statIncrease.防御',
            'max': 'maxGrowthCount', 'enabled': 'enabled', 'chance': 'chance'
          };

          for (const k in data) {
            const lowerK = k.toLowerCase();
            for (const sKey of searchKeys) {
              const prefixes = [sKey + '_', sKey + '-', 'mon-' + sKey + '-'];
              for (const prefix of prefixes) {
                if (lowerK.startsWith(prefix)) {
                  const suffix = k.substring(prefix.length);
                  const targetPath = fieldMapping[suffix.toLowerCase()] || suffix.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                  
                  if (targetPath.includes('.')) {
                    const parts = targetPath.split('.');
                    let current = newObj;
                    for (let i = 0; i < parts.length - 1; i++) {
                      if (!current[parts[i]]) current[parts[i]] = {};
                      current = current[parts[i]];
                    }
                    current[parts[parts.length - 1]] = data[k];
                  } else {
                    newObj[targetPath] = data[k];
                  }
                  found = true;
                }
              }
            }
          }
          if (found) obj = newObj;
          else obj = obj || defaultVal || {};
        }
        
        // 确保 enabled 字段正确转换为布尔值，并补全默认值
        const merged = { ...defaultVal, ...obj };
        merged.enabled = toBool(merged.enabled);
        
        return merged;
      };

      const enrage = extractBehavior('enrage', { hpThreshold: 30, multiplier: 1.5 });
      const flee = extractBehavior('flee', { hpThreshold: 20, chance: 0.5 });
      const killGrowth = extractBehavior('killGrowth', { 
        statIncrease: { 攻击: 0, 防御: 0 }, 
        maxGrowthCount: 10 
      });

      const aggressive = toBool(data.aggressive) ? 1 : 0;
      const aggressive_chance = parseFloat(data.aggressive_chance || data.aggressiveChance || 0);

      // 优先使用 rowid 进行更新以支持重命名和固定排序
      if (data.rowid) {
        await db.run(
          `UPDATE monsters SET 
            name = ?, category = ?, description = ?, level = ?, stats = ?, skills = ?, drops = ?, 
            expReward = ?, aggressive = ?, aggressive_chance = ?, enrage = ?, flee = ?, 
            respawnTime = ?, kill_growth = ?, updated_at = ?
          WHERE rowid = ?`,
        name, data.category || '普通', data.description || '', data.level || 1,
          JSON.stringify(data.stats || {}), JSON.stringify(data.skills || []), 
          JSON.stringify(data.drops || []), data.expReward || data.exp_reward || 0,
          aggressive, aggressive_chance, JSON.stringify(enrage), JSON.stringify(flee),
          data.respawnTime || data.respawn_time || 30, JSON.stringify(killGrowth), now,
          data.rowid
        );
      } else {
        const existing = await db.get('SELECT rowid FROM monsters WHERE name = ?', name);
        if (existing) {
          await db.run(
            `UPDATE monsters SET 
              category = ?, description = ?, level = ?, stats = ?, skills = ?, drops = ?, 
              expReward = ?, aggressive = ?, aggressive_chance = ?, enrage = ?, flee = ?, 
              respawnTime = ?, kill_growth = ?, updated_at = ?
            WHERE name = ?`,
          data.category || '普通', data.description || '', data.level || 1,
            JSON.stringify(data.stats || {}), JSON.stringify(data.skills || []), 
            JSON.stringify(data.drops || []), data.expReward || data.exp_reward || 0,
            aggressive, aggressive_chance, JSON.stringify(enrage), JSON.stringify(flee),
            data.respawnTime || data.respawn_time || 30, JSON.stringify(killGrowth), now,
            name
          );
        } else {
          await db.run(
            `INSERT INTO monsters (
              name, category, description, level, stats, skills, drops, expReward, 
              aggressive, aggressive_chance, enrage, flee, respawnTime, 
              kill_growth, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          name, data.category || '普通', data.description || '', data.level || 1,
            JSON.stringify(data.stats || {}), JSON.stringify(data.skills || []), 
            JSON.stringify(data.drops || []), data.expReward || data.exp_reward || 0,
            aggressive, aggressive_chance, JSON.stringify(enrage), JSON.stringify(flee),
            data.respawnTime || data.respawn_time || 30, JSON.stringify(killGrowth), now
          );
        }
      }
    };
    db.deleteMonster = async (name) => await db.run('DELETE FROM monsters WHERE name = ?', name);

    // 6. 物品 (items)
    db.getItem = async (name) => {
      const r = await db.get('SELECT rowid, * FROM items WHERE name = ?', name);
      if (!r) return null;
      return {
        rowid: r.rowid,
        ...r,
        effects: JSON.parse(r.effects || '[]'),
        rewards: JSON.parse(r.rewards || '[]'),
        classChange: JSON.parse(r.classChange || r.class_change || '{}'),
        stackable: !!r.stackable
      };
    };
    db.getAllItems = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM items ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        effects: JSON.parse(r.effects || '[]'),
        rewards: JSON.parse(r.rewards || '[]'),
        classChange: JSON.parse(r.classChange || r.class_change || '{}'),
        stackable: !!r.stackable
      }));
    };
    db.saveItem = async (name, data) => {
      const now = new Date().toISOString();
      if (data.rowid) {
        await db.run(
          'UPDATE items SET name = ?, category = ?, type = ?, effects = ?, rewards = ?, classChange = ?, description = ?, stackable = ?, max_stack = ?, use_limit = ?, cooldown = ?, conditions = ?, updated_at = ? WHERE rowid = ?',
        name, data.category, data.type, JSON.stringify(data.effects), JSON.stringify(data.rewards), JSON.stringify(data.classChange || data.class_change || {}), data.description, data.stackable ? 1 : 0, data.max_stack, data.use_limit || 0, data.cooldown || 0, JSON.stringify(data.conditions || {}), now, data.rowid);
      } else {
        const existing = await db.get('SELECT rowid FROM items WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE items SET category = ?, type = ?, effects = ?, rewards = ?, classChange = ?, description = ?, stackable = ?, max_stack = ?, use_limit = ?, cooldown = ?, conditions = ?, updated_at = ? WHERE name = ?',
          data.category, data.type, JSON.stringify(data.effects), JSON.stringify(data.rewards), JSON.stringify(data.classChange || data.class_change || {}), data.description, data.stackable ? 1 : 0, data.max_stack, data.use_limit || 0, data.cooldown || 0, JSON.stringify(data.conditions || {}), now, name);
        } else {
          await db.run(
            'INSERT INTO items (name, category, type, effects, rewards, classChange, description, stackable, max_stack, use_limit, cooldown, conditions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, data.category, data.type, JSON.stringify(data.effects), JSON.stringify(data.rewards), JSON.stringify(data.classChange || data.class_change || {}), data.description, data.stackable ? 1 : 0, data.max_stack, data.use_limit || 0, data.cooldown || 0, JSON.stringify(data.conditions || {}), now);
        }
      }
    };
    db.deleteItem = async (name) => await db.run('DELETE FROM items WHERE name = ?', name);

    // 7. 装备 (equipment)
    db.getEquipment = async (name) => {
      const r = await db.get('SELECT rowid, * FROM equipment WHERE name = ?', name);
      if (!r) return null;
      return {
        rowid: r.rowid,
        ...r,
        stats: JSON.parse(r.stats || '{}'),
        unsealMaterials: JSON.parse(r.unsealMaterials || r.unseal_materials || '[]'),
        sealed: !!r.sealed
      };
    };
    db.getAllEquipment = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM equipment ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        stats: JSON.parse(r.stats || '{}'),
        unsealMaterials: JSON.parse(r.unsealMaterials || r.unseal_materials || '[]'),
        sealed: !!r.sealed
      }));
    };
    db.saveEquipment = async (name, data) => {
      const now = new Date().toISOString();
      if (data.rowid) {
        await db.run(
          'UPDATE equipment SET name = ?, slot_id = ?, level_required = ?, class_required = ?, stats = ?, skill = ?, setEffect = ?, sealed = ?, unsealMaterials = ?, description = ?, updated_at = ? WHERE rowid = ?',
        name, data.slot_id || data.slotId, data.level_required || data.levelRequired || 0,
          data.class_required || data.classRequired || null, JSON.stringify(data.stats || {}),
          data.skill || null, data.setEffect || data.set_effect || data.set_id || null,
          data.sealed ? 1 : 0, JSON.stringify(data.unsealMaterials || data.unseal_materials || []),
          data.description || '', now, data.rowid
        );
      } else {
        const existing = await db.get('SELECT rowid FROM equipment WHERE name = ?', name);
        if (existing) {
          await db.run(
            'UPDATE equipment SET slot_id = ?, level_required = ?, class_required = ?, stats = ?, skill = ?, setEffect = ?, sealed = ?, unsealMaterials = ?, description = ?, updated_at = ? WHERE name = ?',
          data.slot_id || data.slotId, data.level_required || data.levelRequired || 0,
            data.class_required || data.classRequired || null, JSON.stringify(data.stats || {}),
            data.skill || null, data.setEffect || data.set_effect || data.set_id || null,
            data.sealed ? 1 : 0, JSON.stringify(data.unsealMaterials || data.unseal_materials || []),
            data.description || '', now, name
          );
        } else {
          await db.run(
            'INSERT INTO equipment (name, slot_id, level_required, class_required, stats, skill, setEffect, sealed, unsealMaterials, description, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          name, data.slot_id || data.slotId, data.level_required || data.levelRequired || 0,
            data.class_required || data.classRequired || null, JSON.stringify(data.stats || {}),
            data.skill || null, data.setEffect || data.set_effect || data.set_id || null,
            data.sealed ? 1 : 0, JSON.stringify(data.unsealMaterials || data.unseal_materials || []),
            data.description || '', now
          );
        }
      }
    };
    db.deleteEquipment = async (name) => await db.run('DELETE FROM equipment WHERE name = ?', name);
    
    // 7.1 商店 (shops)
    db.getAllShops = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM shops ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        items: JSON.parse(r.items || '[]'),
        discount_enabled: !!r.discount_enabled
      }));
    };
    db.saveShop = async (name, data) => {
      const __normalizeShopItems = (items) => {
        if (typeof items === 'string') {
          try { items = JSON.parse(items); } catch (e) { items = []; }
        }
        if (!Array.isArray(items)) items = [];
        return JSON.stringify(items);
      };
      const now = new Date().toISOString();
      const targetId = data.id || data.rowid;
      if (targetId) {
        await db.run(
          `UPDATE shops SET 
            name = ?, description = ?, items = ?, acquisition_ratio = ?, refresh_interval = ?, 
            discount_enabled = ?, discount_value = ?, discount_duration = ?, npc_name = ?, 
            last_refresh_time = ?, discount_start_time = ?, updated_at = ?
          WHERE rowid = ?`,
        name, data.description || '', __normalizeShopItems(data.items), 
          data.acquisition_ratio || 0.5, data.refresh_interval || 0,
          data.discount_enabled ? 1 : 0, data.discount_value || 100, data.discount_duration || 0,
          data.npc_name || null, data.last_refresh_time || now, data.discount_start_time || null, now,
          targetId
        );
      } else {
        const existing = await db.get('SELECT rowid FROM shops WHERE name = ?', name);
        if (existing) {
          await db.run(
            `UPDATE shops SET 
              description = ?, items = ?, acquisition_ratio = ?, refresh_interval = ?, 
              discount_enabled = ?, discount_value = ?, discount_duration = ?, npc_name = ?, 
              last_refresh_time = ?, discount_start_time = ?, updated_at = ?
            WHERE name = ?`,
          data.description || '', __normalizeShopItems(data.items), 
            data.acquisition_ratio || 0.5, data.refresh_interval || 0,
            data.discount_enabled ? 1 : 0, data.discount_value || 100, data.discount_duration || 0,
            data.npc_name || null, data.last_refresh_time || now, data.discount_start_time || null, now,
            name
          );
        } else {
          await db.run(
            `INSERT INTO shops (
              name, description, items, acquisition_ratio, refresh_interval, 
              discount_enabled, discount_value, discount_duration, npc_name, 
              last_refresh_time, discount_start_time, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          name, data.description || '', __normalizeShopItems(data.items), 
            data.acquisition_ratio || 0.5, data.refresh_interval || 0,
            data.discount_enabled ? 1 : 0, data.discount_value || 100, data.discount_duration || 0,
            data.npc_name || null, data.last_refresh_time || now, data.discount_start_time || null, now
          );
        }
      }
    };
    db.deleteShop = async (name) => await db.run('DELETE FROM shops WHERE name = ?', name);

    // 7.2 NPC (npcs)
    db.getAllNpcs = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM npcs ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        functions: JSON.parse(r.functions || '[]'),
        quests: JSON.parse(r.quests || '[]'),
        exchange_settings: JSON.parse(r.exchange_settings || '{}')
      }));
    };
    db.saveNpc = async (name, data) => {
      const now = new Date().toISOString();
      const targetId = data.id || data.rowid;
      if (targetId) {
        await db.run(
          `UPDATE npcs SET 
            name = ?, description = ?, functions = ?, move_probability = ?, quests = ?, 
            shop_name = ?, exchange_settings = ?, map_name = ?, updated_at = ?
          WHERE rowid = ?`,
        name, data.description || '', JSON.stringify(data.functions || []),
          data.move_probability || 0, JSON.stringify(data.quests || []),
          data.shop_name || null, JSON.stringify(data.exchange_settings || {}),
          data.map_name || '', now, targetId
        );
      } else {
        const existing = await db.get('SELECT rowid FROM npcs WHERE name = ?', name);
        if (existing) {
          await db.run(
            `UPDATE npcs SET 
              description = ?, functions = ?, move_probability = ?, quests = ?, 
              shop_name = ?, exchange_settings = ?, map_name = ?, updated_at = ?
            WHERE name = ?`,
          data.description || '', JSON.stringify(data.functions || []),
            data.move_probability || 0, JSON.stringify(data.quests || []),
            data.shop_name || null, JSON.stringify(data.exchange_settings || {}),
            data.map_name || '', now, name
          );
        } else {
          await db.run(
            `INSERT INTO npcs (
              name, description, functions, move_probability, quests, 
              shop_name, exchange_settings, map_name, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          name, data.description || '', JSON.stringify(data.functions || []),
            data.move_probability || 0, JSON.stringify(data.quests || []),
            data.shop_name || null, JSON.stringify(data.exchange_settings || {}),
            data.map_name || '', now
          );
        }
      }
    };
    db.deleteNpc = async (name) => await db.run('DELETE FROM npcs WHERE name = ?', name);

    db.getNpc = async (name) => {
      const r = await db.get('SELECT rowid, * FROM npcs WHERE name = ?', name);
      if (!r) return null;
      return {
        rowid: r.rowid,
        ...r,
        functions: JSON.parse(r.functions || '[]'),
        quests: JSON.parse(r.quests || '[]'),
        exchange_settings: JSON.parse(r.exchange_settings || '{}')
      };
    };

    // 8. 装备套装 (equipment_sets)
    db.getAllEquipmentSets = async () => {
      const rows = await db.all('SELECT rowid AS id, * FROM equipment_sets ORDER BY rowid ASC');
      return rows.map(r => ({
        id: r.id,
        ...r,
        components: JSON.parse(r.components || '[]'),
        effects: JSON.parse(r.effects || '{}')
      }));
    };
    db.getEquipmentSetById = async (id) => {
      const row = await db.get('SELECT * FROM equipment_sets WHERE id = ?', id);
      if (row) {
        row.components = JSON.parse(row.components || '[]');
        row.effects = JSON.parse(row.effects || '{}');
      }
      return row;
    };
    db.saveEquipmentSet = async (data) => {
      const now = new Date().toISOString();
      if (data.id) {
        await db.run(
          'UPDATE equipment_sets SET name = ?, description = ?, components = ?, effects = ?, updated_at = ? WHERE id = ?',
        data.name, data.description || '', JSON.stringify(data.components || []), JSON.stringify(data.effects || {}), now, data.id);
        return data.id;
      } else {
        const res = await db.run(
          'INSERT INTO equipment_sets (name, description, components, effects, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        data.name, data.description || '', JSON.stringify(data.components || []), JSON.stringify(data.effects || {}), now, now);
        return res.lastID;
      }
    };
    db.deleteEquipmentSet = async (id) => await db.run('DELETE FROM equipment_sets WHERE id = ?', id);

    /**
     * 初始化表结构
     */
    db.initSchema = async () => {
      core.log('info', '正在初始化数据库表结构...');

      // 核心系统表
      await db.exec(`
        CREATE TABLE IF NOT EXISTS custom_commands (
          id TEXT PRIMARY KEY,
          trigger TEXT NOT NULL UNIQUE,
          aliases TEXT DEFAULT '[]',
          room TEXT DEFAULT '',
          logical_name TEXT DEFAULT '',
          template_key TEXT DEFAULT '',        -- 引用 message_templates.template_key
          enabled INTEGER DEFAULT 1,
          is_custom INTEGER DEFAULT 0,
          description TEXT DEFAULT '',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS message_templates (
          id TEXT PRIMARY KEY,
          room TEXT NOT NULL,
          template_key TEXT NOT NULL,
          text_content TEXT,
          markdown_content TEXT,
          updated_at TEXT,
          UNIQUE(room, template_key)
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS aliases (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          field TEXT NOT NULL UNIQUE,
          alias TEXT NOT NULL,
          enabled INTEGER DEFAULT 1,
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS variables (
          name TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          description TEXT DEFAULT '',
          contexts TEXT DEFAULT '',
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS editor_settings (
          key TEXT PRIMARY KEY,
          value TEXT DEFAULT '',
          updated_at TEXT
        );
      `);

      // 玩家数据表 (players.db)
      await db.playerDb.exec(`
        -- 玩家主表
        CREATE TABLE IF NOT EXISTS players (
          id TEXT PRIMARY KEY,
          nickname TEXT,
          gender TEXT,
          qq TEXT,
          level INTEGER DEFAULT 1,
          exp INTEGER DEFAULT 0,
          profession_path TEXT,
          profession_sequence TEXT,
          initial_map TEXT,
          current_map TEXT,
          state TEXT DEFAULT 'alive',
          death_time TEXT,
          registered_at TEXT,
          updated_at TEXT,
          meta_json TEXT
        );

        -- 玩家属性
        CREATE TABLE IF NOT EXISTS player_attributes (
          player_id TEXT PRIMARY KEY,
          hp INTEGER DEFAULT 100,
          hp_max INTEGER DEFAULT 100,
          mp INTEGER DEFAULT 50,
          mp_max INTEGER DEFAULT 50,
          attack INTEGER DEFAULT 10,
          defense INTEGER DEFAULT 5,
          crit_rate REAL DEFAULT 5,
          crit_damage REAL DEFAULT 150,
          dodge_rate REAL DEFAULT 5,
          updated_at TEXT,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家货币
        CREATE TABLE IF NOT EXISTS player_currency (
          player_id TEXT NOT NULL,
          currency_type TEXT NOT NULL,
          amount INTEGER DEFAULT 0,
          updated_at TEXT,
          PRIMARY KEY (player_id, currency_type),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家背包
        CREATE TABLE IF NOT EXISTS player_backpack (
          player_id TEXT NOT NULL,
          item_name TEXT NOT NULL,
          quantity INTEGER DEFAULT 0,
          updated_at TEXT,
          PRIMARY KEY (player_id, item_name),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家装备栏
        CREATE TABLE IF NOT EXISTS player_equipment (
          player_id TEXT NOT NULL,
          slot_id TEXT NOT NULL,
          equipment_name TEXT,
          updated_at TEXT,
          PRIMARY KEY (player_id, slot_id),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家技能
        CREATE TABLE IF NOT EXISTS player_skills (
          player_id TEXT NOT NULL,
          skill_name TEXT NOT NULL,
          learned_at TEXT,
          PRIMARY KEY (player_id, skill_name),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家任务
        CREATE TABLE IF NOT EXISTS player_quests (
          player_id TEXT NOT NULL,
          quest_name TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          progress TEXT DEFAULT '',
          accepted_at TEXT,
          completed_at TEXT,
          PRIMARY KEY (player_id, quest_name),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 玩家 buff
        CREATE TABLE IF NOT EXISTS player_buffs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id TEXT NOT NULL,
          buff_name TEXT NOT NULL,
          multiplier REAL DEFAULT 1.0,
          expires_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 签到记录
        CREATE TABLE IF NOT EXISTS sign_in_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          player_id TEXT NOT NULL,
          sign_date TEXT NOT NULL,
          streak INTEGER DEFAULT 1,
          total INTEGER DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(player_id, sign_date),
          FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
        );

        -- 索引
        CREATE INDEX IF NOT EXISTS idx_player_backpack_id ON player_backpack(player_id);
        CREATE INDEX IF NOT EXISTS idx_player_currency_id ON player_currency(player_id);
        CREATE INDEX IF NOT EXISTS idx_player_equipment_id ON player_equipment(player_id);
        CREATE INDEX IF NOT EXISTS idx_player_skills_id ON player_skills(player_id);
        CREATE INDEX IF NOT EXISTS idx_player_quests_id ON player_quests(player_id);
        CREATE INDEX IF NOT EXISTS idx_sign_in_player ON sign_in_records(player_id);
      `);

      // 业务表
      await db.exec(`
        CREATE TABLE IF NOT EXISTS items (
          name TEXT PRIMARY KEY,
          category TEXT NOT NULL,
          type TEXT NOT NULL,
          effects TEXT DEFAULT '[]',
          rewards TEXT DEFAULT '[]',
          classChange TEXT DEFAULT '{}',
          description TEXT DEFAULT '',
          stackable INTEGER DEFAULT 1,
          max_stack INTEGER DEFAULT 99,
          use_limit INTEGER DEFAULT 0,
          cooldown INTEGER DEFAULT 0,
          conditions TEXT DEFAULT '{}',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS monsters (
          name TEXT PRIMARY KEY,
          category TEXT DEFAULT '普通',
          description TEXT DEFAULT '',
          level INTEGER DEFAULT 1,
          stats TEXT DEFAULT '{}',
          skills TEXT DEFAULT '[]',
          drops TEXT DEFAULT '[]',
          expReward INTEGER DEFAULT 0,
          aggressive INTEGER DEFAULT 0,
          aggressive_chance REAL DEFAULT 0,
          enrage TEXT DEFAULT '{}',
          flee TEXT DEFAULT '{}',
          respawnTime INTEGER DEFAULT 30,
          kill_growth TEXT DEFAULT '{}',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS equipment (
          name TEXT PRIMARY KEY,
          slot_id TEXT NOT NULL,
          level_required INTEGER DEFAULT 0,
          class_required TEXT DEFAULT NULL,
          stats TEXT DEFAULT '{}',
          skill TEXT DEFAULT NULL,
          setEffect TEXT DEFAULT NULL,
          sealed INTEGER DEFAULT 0,
          unsealMaterials TEXT DEFAULT '[]',
          description TEXT DEFAULT '',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS equipment_slots (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS equipment_sets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          description TEXT DEFAULT '',
          components TEXT NOT NULL,
          effects TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_equipment_sets_name ON equipment_sets(name);
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS maps (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          monsters TEXT DEFAULT '[]',
          npcs TEXT DEFAULT '[]',
          items TEXT DEFAULT '[]',
          connections TEXT DEFAULT '{}',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS npcs (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          functions TEXT DEFAULT '[]',
          move_probability REAL DEFAULT 0,
          quests TEXT DEFAULT '[]',
          shop_name TEXT DEFAULT NULL,
          exchange_settings TEXT DEFAULT '{}',
          map_name TEXT DEFAULT '',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS quests (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          category TEXT DEFAULT 'side',
          rewards TEXT DEFAULT '[]',
          conditions TEXT DEFAULT '[]',
          objectives TEXT DEFAULT '[]',
          type TEXT DEFAULT 'kill',
          type_value TEXT DEFAULT '',
          npc_name TEXT DEFAULT NULL,
          enabled INTEGER DEFAULT 1,
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS shops (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          items TEXT DEFAULT '[]',
          acquisition_ratio REAL DEFAULT 0.5,
          refresh_interval INTEGER DEFAULT 0,
          discount_enabled INTEGER DEFAULT 0,
          discount_value INTEGER DEFAULT 100,
          discount_duration INTEGER DEFAULT 0,
          npc_name TEXT DEFAULT NULL,
          last_refresh_time TEXT,
          discount_start_time TEXT,
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS skills (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          cost TEXT DEFAULT '{}',
          effect TEXT DEFAULT '',
          effect_value INTEGER DEFAULT 0,
          effect_target TEXT DEFAULT '',
          effect_value_str TEXT DEFAULT '',
          target TEXT DEFAULT '敌人',
          type TEXT DEFAULT '主动',
          cooldown INTEGER DEFAULT 0,
          duration INTEGER DEFAULT 0,
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS professions (
          name TEXT PRIMARY KEY,
          description TEXT DEFAULT '',
          growth_curve TEXT DEFAULT '{}',
          default_skills TEXT DEFAULT '[]',
          sequences TEXT DEFAULT '[]',
          transfer_conditions TEXT DEFAULT '{}',
          transfer_cost TEXT DEFAULT '[]',
          updated_at TEXT
        );
      `);

      await db.exec(`
        CREATE TABLE IF NOT EXISTS event_logs (
          id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          player_id TEXT,
          payload TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS heartbeat_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          beat_time TEXT NOT NULL,
          db_ok INTEGER DEFAULT 1,
          modules_ok INTEGER DEFAULT 1,
          action TEXT DEFAULT '',
          details TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_heartbeat_logs_time ON heartbeat_logs(beat_time);

        CREATE TABLE IF NOT EXISTS player_routes (
          player_id TEXT PRIMARY KEY,
          platform TEXT NOT NULL,
          channel TEXT NOT NULL,
          channel_id TEXT,
          user_id TEXT,
          plugin_url TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS push_queue (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          type TEXT NOT NULL,
          target_id TEXT,
          plugin_url TEXT NOT NULL,
          msg_type TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          retry_count INTEGER DEFAULT 0,
          max_retry INTEGER DEFAULT 3,
          next_retry_at TEXT,
          error TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );

        CREATE TABLE IF NOT EXISTS push_dedupe (
          dedupe_key TEXT NOT NULL,
          player_id TEXT NOT NULL,
          pushed_at TEXT NOT NULL,
          PRIMARY KEY (dedupe_key, player_id)
        );
      `);

      // 超级自定义模块 (SuperModule) 三表 —— 2026-09-15 新增
      await db.exec(`
        CREATE TABLE IF NOT EXISTS custom_logic (
          key TEXT PRIMARY KEY,
          name TEXT DEFAULT '',
          editor_mode TEXT DEFAULT 'block',
          graph TEXT NOT NULL DEFAULT '{"nodes":[],"edges":[]}',
          code TEXT DEFAULT '',
          language TEXT DEFAULT 'dsl',
          trigger_type TEXT DEFAULT 'command',
          trigger TEXT DEFAULT NULL,
          cron_expr TEXT DEFAULT NULL,
          input_schema TEXT DEFAULT '[]',
          output_schema TEXT DEFAULT '{}',
          template_key TEXT DEFAULT NULL,
          enabled INTEGER DEFAULT 1,
          is_library INTEGER DEFAULT 0,
          timeout_ms INTEGER DEFAULT 3000,
          max_steps INTEGER DEFAULT 1000,
          author TEXT DEFAULT '',
          tags TEXT DEFAULT '[]',
          version INTEGER DEFAULT 1,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS custom_logic_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          version INTEGER NOT NULL,
          graph TEXT NOT NULL,
          note TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS custom_logic_run (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL,
          player_id TEXT DEFAULT '',
          trigger_source TEXT DEFAULT '',
          duration_ms INTEGER DEFAULT 0,
          ok INTEGER DEFAULT 1,
          error TEXT DEFAULT '',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // 索引
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_commands_room ON custom_commands(room);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_custom_commands_trigger ON custom_commands(trigger);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_message_templates_room ON message_templates(room);`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_message_templates_key ON message_templates(template_key);`);

      core.log('info', '表结构初始化完成。');
    };

    /**
     * 初始化默认数据
     */
    db.initDefaultData = async () => {
      core.log('info', '正在检查并补充默认数据...');
      const defaultData = require('../modules/defaultData');
      
      // 遍历所有默认设置，如果不存在则插入
      for (const item of defaultData.settings) {
        const existingSetting = await db.getEditorSetting(item.key);
        if (existingSetting === undefined || existingSetting === null) {
          await db.setEditorSetting(item.key, item.value);
        }
      }

      // 2. 消息模板 (只在缺失时插入，不覆盖数据库中已有的模板 —— 2026-09-14 优化)
      for (const item of defaultData.templates) {
        // normalize: room + key -> full key (兼容 {room, key} 与 {key} 两种写法)
        if (item.room) {
          item.key = item.room + '.' + item.key;
        }
        const parts = item.key.split('.');
        const room = parts[0];
        const templateKey = parts.slice(1).join('.');
        const existing = await db.getMessageTemplate(room, templateKey);
        if (!existing) {
          await db.setMessageTemplate(
            item.key, // id
            room,     // room
            templateKey, // templateKey
            item.template_text || '', // textContent
            item.template_markdown || '' // markdownContent
          );
        }
      }

      // 3. 自定义指令 (只在缺失时插入，不覆盖数据库中已有的指令配置 —— 2026-09-14 优化)
      const allCommands = await db.getAllCustomCommands(); // 获取所有当前数据库中的指令
      for (const item of defaultData.commands) {
        core.log('debug', `[db.initDefaultData] Processing command item: ${JSON.stringify(item)}`); // Added for debugging
        const existing = await db.getCustomCommand(item.name);
        if (!existing) {
          await db.setCustomCommand({
            id: crypto.randomUUID(), // Generate a new ID for default commands
            trigger: item.name,
            aliases: (item.aliases || '').split(',').map(s => s.trim()),
            enabled: true,
            room: item.module, // 确保 room 字段被设置
            logical_name: item.logical_name,
            description: item.description,
            template_key: item.template_key || '',
            is_custom: 0 // Default commands are not custom
          });
        }
      }

      // 4. 自定义变量
      for (const item of defaultData.variables) {
        const existing = await db.getVariable(item.name);
        if (!existing) {
          await db.saveVariable(item.name, item.value, item.description);
        }
      }

      // 5. 属性别名
      for (const item of defaultData.aliases) {
        const existing = await db.getAlias(item.field);
        if (!existing) {
          await db.saveAlias(item.field, item.alias);
        }
      }

      // 6. 任务数据
      const combinedQuests = defaultData.quests || [];
      const existingQuests = await db.all('SELECT name FROM quests');
      for (const item of combinedQuests) {
        if (!existingQuests.find(q => q.name === item.name)) {
          await db.saveQuest(item.name, item);
        }
      }

      // 7. 商店数据
      const combinedShops = defaultData.shops || [];
      const existingShops = await db.all('SELECT name FROM shops');
      for (const item of combinedShops) {
        if (!existingShops.find(q => q.name === item.name)) {
          await db.saveShop(item.name, item);
        }
      }

      // 8. NPC 数据
      const combinedNpcs = defaultData.npcs || [];
      const existingNpcs = await db.all('SELECT name FROM npcs');
      for (const item of combinedNpcs) {
        if (!existingNpcs.find(q => q.name === item.name)) {
          await db.saveNpc(item.name, item);
        }
      }

      core.log('info', '所有默认数据初始化检查完成。');

    };

    // 执行初始化
    await db.initSchema();
    await db.initDefaultData();

    // 挂载到核心
    core.db = db;
    core.log('info', '数据库模块连接成功并已挂载到核心。');

    // 返回清理函数
    return {
      db, // main game.db connection
      playerDb: db.playerDb, // players.db connection
      unload: async () => {
        core.log('info', '正在关闭数据库连接...');
        try { await db.run('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
        await db.close();
        if (db.playerDb) {
          try { await db.playerDb.run('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
          await db.playerDb.close();
        }
        core.log('info', '数据库连接已安全关闭。');
      }
    };
  } catch (err) {
    core.log('error', `数据库模块启动失败: ${err.message}`);
    throw err;
  }
}

databaseModule.moduleName = 'database';

module.exports = databaseModule;