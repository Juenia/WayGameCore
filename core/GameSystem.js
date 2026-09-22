const fs = require('fs').promises;
const path = require('path');

/**
 * 玩家「读-改-写」串行锁（按 playerId）· 2026-09-20
 * =====================================================================
 * modify / giveItems / takeItems / giveCurrency / takeCurrency 都是
 * 「读整份玩家 → 改一处 → 写回整份」。两个这样的操作一交叠：
 *      A 读(快照 v1) … B 读(快照 v1) … A 写(v1+a) … B 写(v1+b)
 * 后写的那个用它手里的**旧快照**把前一个的改动盖掉 —— 丢更新。
 * 实测（tools/verify-player-write-race.js 改前那一版）：
 *      6 个并发 modify 各改一个字段 → 只有最后 1 个活下来；
 *      10 个并发 {经验: +1} → 只加了 1；
 *      并发「改生命」与「给物品」→ 改生命那次被盖掉。
 * 核心是单进程，一把按 playerId 的队列就够：只让**同一个人**的操作排队，
 * 不同玩家互不阻塞（各方法内部都是直接走 db，不会互相调用，所以不存在自锁）。
 */
const PLAYER_WRITE_LOCKS = new Map();
function withPlayerWriteLock(playerId, task) {
  if (!playerId) return Promise.resolve().then(task);
  const prev = PLAYER_WRITE_LOCKS.get(playerId) || Promise.resolve();
  const next = prev.then(task, task);              // 前一个失败也继续排队（照 databaseModule 里 saveLocks 的先例）
  const settled = next.catch(() => {});            // 队列里存"不会 reject"的那份，免得一个失败卡死后面所有
  PLAYER_WRITE_LOCKS.set(playerId, settled);
  // 队列跑空就把这条记录删掉，别让它跟着玩家数一直涨
  settled.then(() => { if (PLAYER_WRITE_LOCKS.get(playerId) === settled) PLAYER_WRITE_LOCKS.delete(playerId); });
  return next;
}

/**
 * GameSystem - 文字游戏核心引擎
 */
class GameSystem {
  constructor(config = {}) {
    // 基础配置
    this.config = {
      version: '1.0.0',
      savePath: path.join(__dirname, '..', 'data', 'state.json'),
      logFile: path.join(__dirname, '..', 'data', 'game.log'),
      logLevel: 'info', // Set log level to info to reduce log volume
      stopTimeout: 10000, // 停止时的超时时间（毫秒）
      messages: {
        playerNotFound: "玩家 {playerId} 尚未注册，请先注册角色。"
      },
      ...config
    };
    
    // 核心状态
    this.state = {
      _version: this.config.version,
      players: {},
      world: {},
      ...config.initialState
    };
    
    // 注册中心
    this.modules = new Map(); // 名称 -> { func, cleanup, exports } (不再包含 commands, templates, handlers 字段)
    
    // 新核心调度架构相关
    this.rooms = {};
    this.moduleRegistry = {};
    this._currentLoadingFile = null;           // 模块房间注册表：模块名 → { doors, templates, handlers }
    this.heartbeat = {
      enabled: false,
      interval: 30000,
      lastBeatTime: null,
      consecutiveFails: 0,
      maxFails: 3,
      stats: { totalBeats: 0, dbOkCount: 0, dbFailCount: 0, reconnects: 0, moduleReloads: 0 },
      timer: null
    };
    this.doorHandles = {};     // 门把手表：触发词 → { room, door, enabled }
    this._pendingBindings = []; // 模块默认触发词待同步队列

    // 以下将被逐步废弃或整合
    this.events = new Map(); // 事件名 -> Set<监听器>
    this.middlewares = [];
    this.messageTypes = new Map();
    
    // 运行态管理
    this.db = null;
    this.currentLoadingModule = null;
    this.cooldowns = new Map(); // playerId:commandName -> 时间戳
    this.pendingOperations = new Set(); // 追踪进行中的异步操作
    this.attributeAliases = new Map(); // 字段名 -> 优先显示别名
    this.inputAliases = new Map();     // 别名 -> 原始字段名 (用于输入解析)
    /**
     * 模块私有的「内存态玩家键」白名单（2026-09-19 · 覆盖校验 R8 修复配套）
     * -----------------------------------------------------------------
     * 背景：questModule 会往玩家对象上写一个**不带下划线**的旧键 completedQuests
     * （modules/questModule.js:305 注释写明「内存态旧键（其他逻辑读取）」，持久化那份是 _completedQuests → meta_json）。
     * 字段体检如果不认它，任务完成就会整条失败 —— 这正是本轮门禁当场抓到的那 4 套红。
     * 约定：**新写的内存态键一律用 `_` 前缀**（savePlayer 会收进 meta_json）；
     *       确实需要沿用旧键时，在这里登记一行，并在模块里注明为什么。
     */
    this.legacyPlayerFields = new Set(['completedQuests']);
    
    // 初始化别名映射
     const initialAliases = this.config.attributeAliases || {};
     for (const [field, alias] of Object.entries(initialAliases)) {
       this.setAlias(field, alias);
     }

     this.systemVariables = new Map();   // 系统变量：name -> { getter, aliases }
     this.customVariables = new Map();   // 自定义变量：name -> value

    // === 核心服务 ===
    // Player Service
    this._playerService = {
      get: async (playerId) => {
        if (!this.db) return null;
        const player = await this.db.getPlayer(playerId);
        return player ? JSON.parse(JSON.stringify(player)) : null;
      },
      // 整段「读整份 → 改 → 写回整份」串行化（见文件顶部的 PLAYER_WRITE_LOCKS 说明）
      modify: async ({ playerId, changes, source = 'system', noEmit = false }) => withPlayerWriteLock(playerId, async () => {
        if (!this.db) throw new Error('数据库未连接');
        const player = await this.db.getPlayer(playerId);
        if (!player) return { success: false, message: '玩家不存在' };
        const oldPlayer = JSON.parse(JSON.stringify(player));
        let modified = false;
        
        // Track actual changes for event emission
        const actualChanges = {};

        // 2026-09-19 覆盖校验修复：先做字段体检。以前不认识的字段会被「照写」进内存，
        // savePlayer 存库时静默丢掉，却回 success:true（实测 changes:{审计_怪字段:{set:1}} → success）。
        const fieldErrors = [];
        const normalized = {};
        for (const rawKey in changes) {
          if (!Object.prototype.hasOwnProperty.call(changes, rawKey)) continue;
          const canon = this.canonicalPlayerField(player, rawKey);
          if (!canon) { fieldErrors.push(rawKey); continue; }
          normalized[canon] = changes[rawKey];
        }
        if (fieldErrors.length) {
          return {
            success: false,
            message: '不认识的玩家字段：' + fieldErrors.join('、') + '（可用的有：' + Object.keys(player).join('、') + '；别名如 金币→货币1 也认）',
            unknownFields: fieldErrors,
          };
        }

        for (const key in normalized) {
          if (!Object.prototype.hasOwnProperty.call(normalized, key)) continue;
          const change = normalized[key];
          const oldValue = player[key]; // Get current value, can be any type
          let newValue = oldValue; // Default to current value if no valid change detected

          if (typeof change === 'number') {
            // Numeric change: increment/decrement for numeric properties, otherwise direct set
            newValue = (typeof oldValue === 'number' ? oldValue : 0) + change;
          } else if (change && typeof change === 'object' && !Array.isArray(change)) {
            // Object change: check for 'set' or 'delta' properties
            if ('set' in change) {
              newValue = change.set; // Explicitly set the value
            } else if ('delta' in change) {
              // Explicitly increment/decrement by delta for numeric properties, otherwise direct set
              newValue = (typeof oldValue === 'number' ? oldValue : 0) + change.delta;
            } else {
              // Other objects are treated as direct assignments (e.g., player.背包 = { ... })
              newValue = change;
            }
          } else {
            // For other types (string, boolean, array, null, undefined, or non-object), treat as direct assignment
            newValue = change;
          }

          // Apply Boundary Checks only if newValue is a number
          if (typeof newValue === 'number') {
            if (key === '生命' || key === '魔法') {
              const maxKey = key === '生命' ? '生命上限' : '魔法上限';
              // Fallback to a reasonable default (e.g., current value if max not explicitly defined)
              const max = player[maxKey] || (typeof player[key] === 'number' ? player[key] : Infinity);
              newValue = Math.max(0, Math.min(max, newValue));
            } else if (key === '货币1' || key === '货币2' || key === '货币3' || key === '特殊货币') {
              if (newValue < 0) {
                // If currency goes negative, immediately fail the entire modify operation
                return { success: false, message: `${key} 不足` };
              }
            } else if (key === '攻击' || key === '防御' || key === '经验') {
              newValue = Math.max(0, newValue);
            } else if (key === '等级') {
              newValue = Math.max(1, newValue);
            }
          }
          
          // Only update if value actually changed to prevent unnecessary writes and events
          if (player[key] !== newValue) { // Deep comparison might be needed for objects, but for now, shallow is fine
            player[key] = newValue;
            actualChanges[key] = newValue; // Record the actual change
            modified = true;
          }
        }

        // Death detection (only if '生命' was changed and player was alive previously)
        let died = false;
        // Check oldPlayer.生命 against player.生命 AFTER all changes have been applied
        if (oldPlayer.生命 > 0 && player.生命 <= 0) {
          died = true;
          player.状态 = 'dead';
          player.死亡时间 = new Date().toISOString();
          modified = true; // Ensure player is saved if they die
        }

        if (modified) {
          await this.db.savePlayer(player);
          if (!noEmit) {
            // Only update state and emit if actual changes occurred
            // Use actualChanges for event emission to reflect what truly changed
            this.updateState(`players.${playerId}`, player);
            setImmediate(() => {
              this.emit('player:attribute_changed', playerId, actualChanges, source);
              if (died) this.emit('player:died', playerId, source);
            });
          }
        }

        // Return success/failure after processing all changes
        return {
          success: true, // Only returns false if currency is insufficient
          player: JSON.parse(JSON.stringify(player)), // Return a clone of the updated player
          changes: actualChanges, // Return the actual changes that were applied
          died,
          deathMessage: died ? '角色已死亡' : null
        };
      }),

          giveItems: async ({ targets, items, source = 'system', options = {} }) => {
            const results = [];
            const errors = [];

            let playerIds = [];
            if (targets === 'all') {
              const rows = await this.db.playerDb.all('SELECT id FROM players');
              playerIds = rows.map(r => r.id);
            } else if (Array.isArray(targets)) {
              playerIds = targets;
            } else if (typeof targets === 'string' && targets.trim()) {
              // 2026-09-20：单个玩家 id（字符串）也认。以前传字符串会从「不是数组」这条岔路溜过去，
              // playerIds 为空 → 一个循环都不跑，却回 success:true、errors 为空 ——
              // 调用方以为东西发出去了，实际什么都没发生（就是这一项要修的「静默」）。
              playerIds = [targets.trim()];
            }
            if (!playerIds.length && targets !== 'all') {
              return { success: false, results: [], errors: [{ playerId: '', reason: '没有指定要给谁（targets 要写成玩家 id 的数组、单个 id，或 "all"）' }] };
            }

            for (const playerId of playerIds) {
              // 这个玩家的「读整份 → 加物品 → 写回」整段串行（不同玩家互不阻塞）
              await withPlayerWriteLock(playerId, () => this.services.player._giveItemsToOne(playerId, items, source, options, results, errors));
            }

            return { success: errors.length === 0, results, errors };
          },

          /**
           * giveItems 对**单个玩家**的那一段。抽成方法是因为原循环体里有 continue，
           * 直接在外面包一层 async 会让 continue 跨函数边界（语法错）；这里统一用 return 收尾。
           */
          _giveItemsToOne: async (playerId, items, source, options, results, errors) => {
              try {
                const player = await this.db.getPlayer(playerId);
                if (!player) { errors.push({ playerId, reason: '玩家不存在' }); return; }

                const backpack = player.背包 || {};
                const gained = [];
                const discarded = [];

                for (const item of items) {
                  let itemDef = await this.db.get('SELECT * FROM items WHERE name = ?', [item.name]);
                  let isEquip = false;
                  if (!itemDef) {
                    itemDef = await this.db.get('SELECT * FROM equipment WHERE name = ?', [item.name]);
                    if (itemDef) isEquip = true;
                  }
                  if (!itemDef) { errors.push({ playerId, item: item.name, reason: '物品定义不存在' }); continue; }

                  const stackable = !isEquip && itemDef.stackable !== 0;
                  const maxStack = stackable ? (itemDef.max_stack || 99) : 1;
                  const current = backpack[item.name] || 0;
                  const requested = item.count || 1;
                  
                  const canAdd = Math.max(0, maxStack - current);
                  const actualAdd = Math.min(canAdd, requested);
                  if (actualAdd > 0) {
                    backpack[item.name] = current + actualAdd;
                    gained.push({ name: item.name, count: actualAdd });
                  }
                  const overflow = requested - actualAdd;
                  if (overflow > 0) discarded.push({ name: item.name, count: overflow });
                }

                player.背包 = backpack;
                await this.db.savePlayer(player);
                this.updateState(`players.${playerId}`, player);

                if (!options.silent && gained.length > 0) {
                  setImmediate(() => {
                    try { this.emit('player:item_gained', playerId, gained, source); } catch {}
                  });
                }

                results.push({ playerId, gained, discarded });
              } catch (e) {
                errors.push({ playerId, reason: e.message });
              }
          },

          takeItems: async ({ playerId, items, source = 'system' }) => withPlayerWriteLock(playerId, async () => {
            const player = await this.db.getPlayer(playerId);
            if (!player) return { success: false, message: '玩家不存在' };
            const backpack = player.背包 || {};
            for (const item of items) {
              const current = backpack[item.name] || 0;
              if (current < item.count) {
                return { success: false, message: `物品 ${item.name} 不足，需要 ${item.count}，现有 ${current}` };
              }
            }
            for (const item of items) {
              backpack[item.name] -= item.count;
              if (backpack[item.name] <= 0) delete backpack[item.name];
            }
            player.背包 = backpack;
            await this.db.savePlayer(player);
            this.updateState(`players.${playerId}`, player);
            setImmediate(() => {
              try { this.emit('player:item_lost', playerId, items, source); } catch {}
            });
            return { success: true };
          }),

          giveCurrency: async ({ targets, field, amount, source = 'system' }) => {
            let playerIds = [];
            if (targets === 'all') {
              const rows = await this.db.playerDb.all('SELECT id FROM players');
              playerIds = rows.map(r => r.id);
            } else if (Array.isArray(targets)) {
              playerIds = targets;
            } else if (typeof targets === 'string' && targets.trim()) {
              playerIds = [targets.trim()];   // 同 giveItems：单个 id 也认，别静默什么都不做
            }
            if (!playerIds.length && targets !== 'all') {
              return { success: false, results: [], errors: [{ playerId: '', reason: '没有指定要给谁（targets 要写成玩家 id 的数组、单个 id，或 "all"）' }] };
            }
            const results = [], errors = [];
            for (const playerId of playerIds) {
              // 这个玩家的「读整份 → 加钱 → 写回」整段串行（不同玩家互不阻塞）。
              // 「字段不认识」是**整体中止**（字段是调用方的全局参数），所以把那种结果透出来直接返回。
              const aborted = await withPlayerWriteLock(playerId, () => this.services.player._giveCurrencyToOne(playerId, field, amount, source, results, errors));
              if (aborted) return aborted;
            }
            return { success: errors.length === 0, results, errors: errors.length ? errors : undefined };
          },

          /**
           * giveCurrency 对**单个玩家**的那一段。抽成方法是因为循环体里有 continue，
          * 直接在外面包一层 async 会让 continue 跨函数边界（语法错）。
           * 返回值：非空 = 整个 giveCurrency 要中止（字段不认识）；undefined = 继续下一个玩家。
           */
          _giveCurrencyToOne: async (playerId, field, amount, source, results, errors) => {
            const player = await this.db.getPlayer(playerId);
            // 2026-09-19 覆盖校验收尾：不再静默跳过 —— giveItems / takeCurrency 都是把「玩家不存在」记进 errors 的，
            // 这里跟着统一（以前给钱给到不存在的 id，回 success 却什么都没发生）。
            if (!player) { errors.push({ playerId, reason: '玩家不存在' }); return; }
            // 2026-09-19 覆盖校验修复：① 别名归一（金币→货币1）② 不认识的字段当场说清（以前钱会凭空消失）
            // ③ 结果为负不再照写（实测 giveCurrency(-100) 会把 -100 写进 player_currency）
            const f = this.canonicalPlayerField(player, field);
            if (!f) return { success: false, message: '不认识的货币/字段：' + field + '（可用：货币1/货币2/货币3/特殊货币，或别名 金币/银币/铜币/钻石）' };
            const next = Number(player[f] || 0) + Number(amount || 0);
            if (next < 0) {
              errors.push({ playerId, field: f, reason: f + ' 不足（当前 ' + Number(player[f] || 0) + '，要扣 ' + Math.abs(Number(amount || 0)) + '）' });
              return;
            }
            player[f] = next;
            await this.db.savePlayer(player);
            this.updateState(`players.${playerId}`, player);
            setImmediate(() => {
              try { this.emit('player:currency_gained', playerId, f, amount, source); } catch {}
            });
            results.push({ playerId, field: f, amount });
          },

          takeCurrency: async ({ playerId, field, amount, source = 'system' }) => withPlayerWriteLock(playerId, async () => {
            const player = await this.db.getPlayer(playerId);
            if (!player) return { success: false, message: '玩家不存在' };
            // 2026-09-19 覆盖校验修复：别名归一 + 不认识的字段当场说清（否则会写进内存对象、存库时静默丢掉）
            const f = this.canonicalPlayerField(player, field);
            if (!f) return { success: false, message: '不认识的货币/字段：' + field + '（可用：货币1/货币2/货币3/特殊货币，或别名 金币/银币/铜币/钻石）' };
            const current = Number(player[f] || 0);
            if (current < amount) return { success: false, message: `${f} 不足` };
            player[f] = current - amount;
            await this.db.savePlayer(player);
            this.updateState(`players.${playerId}`, player);
            setImmediate(() => {
              try { this.emit('player:currency_lost', playerId, f, amount, source); } catch {}
            });
            return { success: true };
          }),

          // 通用工具：货币 id → 中文字段名（收敛各模块重复的映射表，2026-09-14 优化）
          currencyField: (id) => {
            if (id === 1 || id === '1') return '货币1';
            if (id === 2 || id === '2') return '货币2';
            if (id === 3 || id === '3') return '货币3';
            if (id === '特殊' || id === 'special' || id === '特殊货币') return '特殊货币';
            return '货币1';
          }


    };
    this.playerService = this._playerService; // 挂载到公开属性

    // Query Service
    this._queryService = {

      _whitelistedTables: new Set(['items', 'monsters', 'equipment', 'professions', 'skills', 'maps', 'npcs', 'quests', 'shops', 'message_templates', 'custom_commands', 'equipment_slots', 'equipment_sets']),

      list: async (table, condition = '') => {
        if (!this.db) throw new Error('数据库未连接，无法查询数据。');
        if (!this._queryService._whitelistedTables.has(table)) {
          throw new Error(`不允许查询表：${table}`);
        }
        let query = `SELECT * FROM ${table}`;
        let params = [];
        // 简单条件支持，避免 SQL 注入
        if (typeof condition === 'object' && condition !== null) {
          const parts = [];
          for (const key in condition) {
            parts.push(`${key} = ?`);
            params.push(condition[key]);
          }
          if (parts.length > 0) {
            query += ` WHERE ${parts.join(' AND ')}`;
          }
        } else if (typeof condition === 'string' && condition) {
          // 字符串条件直接拼接，调用方需确保安全
          query += ` WHERE ${condition}`;
        }
        return await this.db.all(query, params);
      },

      get: async (table, id) => {
        if (!this.db) throw new Error('数据库未连接，无法查询数据。');
        if (!this._queryService._whitelistedTables.has(table)) {
          throw new Error(`不允许查询表：${table}`);
        }
        if (table === 'npcs') {
          return await this.db.getNpc(id);
        }
        // 假设表的主键是 'id' 或 'name'
        const idField = (table === 'custom_commands' || table === 'message_templates' || table === 'professions' || table === 'items' || table === 'monsters' || table === 'equipment' || table === 'skills' || table === 'maps' || table === 'npcs' || table === 'quests' || table === 'shops') ? 'name' : 'id';
        const query = `SELECT * FROM ${table} WHERE ${idField} = ?`;
        return await this.db.get(query, id);
      },

      getAlias: async (field) => {
        if (!this.db) return field;
        try {
          const row = await this.db.get('SELECT alias FROM aliases WHERE field = ? AND enabled = 1', [field]);
          return row && row.alias ? row.alias : field;
        } catch {
          return field;
        }
      }
    };
    this.queryService = this._queryService; // 挂载到公开属性

    // 在 constructor 里，playerService 和 queryService 定义完之后，立即挂载 
    this.services = this.services || {}; 
    this.services.player = this.playerService; 
    this.services.query = this.queryService; 
    
    this.requirePlayer = async (playerId) => {
      if (!this.db) return { error: true, content: '数据库未连接' };
      const player = await this.db.getPlayer(playerId);
      if (!player) return { error: true, content: '玩家不存在，请先注册' };
      if (!this.state.players[playerId]) this.state.players[playerId] = player;
      return player;
    }; 


    // 默认注册消息渲染器
    this.registerMessageType('text', async (content, context) => {
      const data = { ...context, ...(context.message?.data || {}), ...(context.handlerResultData || {}) };
      return await this.renderTemplate(content, data, { escape: true }, context.playerId, context.templateKey);
    });
    this.registerMessageType('markdown', async (content, context) => {
      const data = { ...context, ...(context.message?.data || {}), ...(context.handlerResultData || {}) };
      return await this.renderTemplate(content, data, { escape: false }, context.playerId, context.templateKey);
    });
    this.registerMessageType('image', async (content, context) => {
      const data = { ...context, ...(context.message?.data || {}), ...(context.handlerResultData || {}) };
      const rendered = await this.renderTemplate(content, data, { escape: false }, context.playerId, context.templateKey);
      // 图片模式逻辑预留：如果内容是 URL 则直接返回，否则返回占位
      if (rendered.startsWith('http') || rendered.startsWith('data:image')) {
        return rendered;
      }
      return `[图片占位: ${rendered}]`;
    });

    // 修复 Windows 下的编码问题
    if (process.platform === 'win32') {
      try {
        process.stdout.setEncoding('utf8');
        process.stderr.setEncoding('utf8');
      } catch (e) {
        // 忽略不支持的情况
      }
    }

    // 注册内置中间件：权限与冷却检查
    this.registerMiddleware(async (request) => {
      const { playerId, doorHandle, core } = request;
      
      if (!doorHandle) return; // 如果没有门把手信息，跳过权限和冷却检查

      // 权限检查
      if (doorHandle.permission && !core._checkPermission(playerId, doorHandle.permission)) {
        const err = new Error('权限不足');
        err.code = 'AUTH_FAILED';
        throw err;
      }

      // 冷却检查
      if (doorHandle.cooldown) {
        const key = `${playerId}:${doorHandle.door}`;
        const now = Date.now();
        const last = core.cooldowns.get(key) || 0;
        if (now - last < doorHandle.cooldown * 1000) {
          const err = new Error('操作冷却中');
          err.code = 'COOLDOWN';
          throw err;
        }
        core.cooldowns.set(key, now);
      }
    });
  }

  // --- 1. 模块加载与管理 ---
  
  /**
   * 加载单个模块
   * @param {Function} moduleFunc 模块函数
   * @param {string} filePath 模块文件路径 (可选)
   */
  async loadModule(moduleFunc, explicitFilePath = null) {
    const name = moduleFunc.moduleName || moduleFunc.name || 'anonymous';
    if (this.modules.has(name)) {
      this.log('warn', `模块 ${name} 已加载，跳过。`);
      return;
    }

    // 优先用显式传入的路径 
    let filePath = explicitFilePath;
   
    // 没传时，从 require.cache 反查 
    if (!filePath) {
      const path = require('path');
      for (const [key, cached] of Object.entries(require.cache)) {
        if (cached.exports === moduleFunc) {
          filePath = path.relative(path.join(__dirname, '..'), key).replace(/\\/g, '/');
          break;
        }
      }
    }
    
    // 兜底 
    if (!filePath) filePath = 'unknown';

    // 检查依赖
    if (moduleFunc.dependencies) {
      for (const dep of moduleFunc.dependencies) {
        if (!this.modules.has(dep)) {
          throw new Error(`模块 ${name} 依赖 ${dep}，但该依赖未加载。`);
        }
      }
    }

    try {
      const moduleInfo = {
        func: moduleFunc,
        cleanup: null, // cleanup will be set after moduleFunc execution if it returns a function or object with unload
        exports: {} // exports will be set after moduleFunc execution
      };
      
      this.modules.set(name, moduleInfo); // 先存储基础信息
      this.currentLoadingModule = name;

      this._currentLoadingFile = filePath; // 使用推断出的 filePath

      let result;
      if (typeof moduleFunc === 'function') {
        // Assume most modules are functions to be called with 'this' (core)
        // If there's a need for class instantiation with 'new', it should be handled specifically if it's a common pattern.
        // For now, let's just call it.
        result = await moduleFunc(this);
      } else if (typeof moduleFunc === 'object' && moduleFunc !== null) {
        // If it's a plain object, use it directly as the module's exports.
        result = moduleFunc;
      } else {
        this.log('warn', `模块 ${name} 导出类型异常: ${typeof moduleFunc}。跳过加载。`);
        this.modules.delete(name); // Remove the prematurely added module entry
        return null; // Indicate module was not loaded
      }

      // 更新 moduleInfo 中的 cleanup 和 exports
      moduleInfo.cleanup = typeof result === 'function' ? result : (result?.unload || null);
      moduleInfo.exports = result !== undefined ? result : {}; // 确保 exports 至少是个空对象
      this.log('info', `模块 ${name} 加载成功。`);
      return moduleInfo.exports;
    } catch (err) {
      this.log('error', `模块 ${name} 加载失败: ${err.message}`);
      throw err;
    } finally {
      this.currentLoadingModule = null;
      this._currentLoadingFile = null;
    }
  }

  /**
   * 卸载指定模块
   * @param {string} name 模块名称
   */
  async unloadModule(name) {
    const moduleInfo = this.modules.get(name);
    if (!moduleInfo) return;

    this.log('info', `正在卸载模块 ${name}...`);

    // 1. 调用清理函数
    if (moduleInfo.cleanup) {
      try {
        await moduleInfo.cleanup();
      } catch (err) {
        this.log('error', `清理模块 ${name} 时出错: ${err.message}`);
      }
    }

    // 2. 移除相关资源（指令、监听器、中间件）
    this._cleanupModuleResources(name);

    // 3. 从注册表中删除
    this.modules.delete(name);
    this.log('info', `模块 ${name} 卸载完成。`);
  }

  /**
   * 批量加载模块并处理依赖
   * @param {Array} modules 模块函数数组
   */
  async loadModules(modules) {
    const loaded = new Set();
    const modulesMap = new Map(modules.map(m => [m.moduleName || m.name, m]));

    const load = async (modFunc) => {
      const name = modFunc.moduleName || modFunc.name;
      if (this.modules.has(name) || loaded.has(name)) return;

      if (modFunc.dependencies) {
        for (const dep of modFunc.dependencies) {
          if (!this.modules.has(dep)) {
            // Special handling for 'database' module, which is loaded separately by engine.start
            if (dep === 'database') {
                if (this.modules.has('database')) { // If it's already loaded, skip further checks
                    continue;
                }
            }
            
            const depMod = modulesMap.get(dep);
            if (depMod) {
              await load(depMod);
            } else {
              throw new Error(`模块 ${name} 的依赖项 ${dep} 在提供的模块列表中未找到。`);
            }
          }
        }
      }

      await this.loadModule(modFunc);
      loaded.add(name);
    };

    for (const mod of modules) {
      await load(mod);
    }
  }

  /**
   * 获取模块导出的对象
   */
  getModule(name) {
    const mod = this.modules.get(name);
    return mod ? mod.exports : null;
  }

  /**
   * 内部方法：清理模块注册的资源 (新架构)
   */
  /**
   * 辅助函数：解析别名字符串，兼容 JSON 数组和逗号分隔字符串
   * @param {string} raw 原始别名字符串
   * @returns {Array<string>} 别名数组
   */
  _parseAliases(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw; // Add this line
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      return [String(parsed)];
    } catch {
      // 不是 JSON，按逗号分隔
      return raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }

  /**
   * 内部方法：清理模块注册的资源 (新架构)
   */
  _cleanupModuleResources(moduleName) {
    // 1. 移除 room
    delete this.rooms[moduleName];

    // 2. 移除 doorHandles 中指向该 room 的条目
    for (const trigger in this.doorHandles) {
      if (Object.prototype.hasOwnProperty.call(this.doorHandles, trigger)) {
        if (this.doorHandles[trigger].room === moduleName) {
          delete this.doorHandles[trigger];
        }
      }
    }

    // 4. 移除事件监听器
    for (const [eventName, listeners] of this.events.entries()) {
      for (const listener of listeners) {
        if (listener._moduleName === moduleName) {
          listeners.delete(listener);
        }
      }
    }

    // 5. 移除中间件
    this.middlewares = this.middlewares.filter(mw => mw._moduleName !== moduleName);
  }

  /**
   * 新注册模块方法：将模块的房间、门和模板注册到核心
   * @param {string} moduleName 模块名（如 'player'）
   * @param {Object} definition
   * @param {Array}  definition.doors 门定义数组
   * @param {Object} definition.templates 模板映射 { templateKey: { text, markdown } }
   * @param {Object} definition.handlers 处理器映射 { doorLogicalName: function }
   */
  registerModule(moduleName, definition) {
    if (!moduleName) {
      throw new Error('模块名不能为空。');
    }
    if (this.rooms[moduleName]) {
      this.log('warn', `模块房间 ${moduleName} 已存在，将覆盖。`);
    }

    this.rooms[moduleName] = {
      doors: {},
      templates: definition.templates || {},
      handlers: definition.handlers || {}
    };
    this.log('debug', `[registerModule] 模块 ${moduleName} 注册房间成功。当前房间数: ${Object.keys(this.rooms).length}`);

    for (const door of definition.doors || []) {
      if (!door.logical_name) {
        this.log('warn', `模块 ${moduleName} 的门缺少 logical_name: ${JSON.stringify(door)}`);
        continue;
      }
      this.rooms[moduleName].doors[door.logical_name] = door;
      for (const trigger of door.default_triggers || []) {
        this._pendingBindings.push({ trigger, room: moduleName, door: door.logical_name });
      }
    }
    this.log('info', `模块 ${moduleName} 注册成功。门: ${Object.keys(this.rooms[moduleName].doors).length}, 模板: ${Object.keys(this.rooms[moduleName].templates).length}`);
 
    this.moduleRegistry[moduleName] = {
      module_name: moduleName,
      status: 'loaded',
      version: definition.version || '1.0.0',
      loaded_at: new Date().toISOString(),
      doors: Object.keys(this.rooms[moduleName].doors),
      templates_count: Object.keys(this.rooms[moduleName].templates).length,
      handlers_count: Object.keys(this.rooms[moduleName].handlers).length,
      file_path: this._currentLoadingFile || 'unknown',
      error: null
    };
  }

  listModules() {
    return Object.values(this.moduleRegistry);
  }

  getModuleInfo(moduleName) {
    return this.moduleRegistry[moduleName] || null;
  }

  startHeartbeat(options = {}) {
    if (this.heartbeat.timer) this.stopHeartbeat();
    this.heartbeat.interval = options.interval || 30000;
    this.heartbeat.maxFails = options.maxFails || 3;
    this.heartbeat.enabled = true;
    this.heartbeat.timer = setInterval(() => {
      this.beat().catch(err => this.log('error', `心跳失败: ${err.message}`));
    }, this.heartbeat.interval);
    this.log('info', `心跳检查器已启动，间隔 ${this.heartbeat.interval}ms`);
  }

  stopHeartbeat() {
    if (this.heartbeat.timer) {
      clearInterval(this.heartbeat.timer);
      this.heartbeat.timer = null;
    }
    this.heartbeat.enabled = false;
    this.log('info', '心跳检查器已停止');
  }

  async beat() {
    const beatTime = new Date().toISOString();
    this.heartbeat.lastBeatTime = beatTime;
    this.heartbeat.stats.totalBeats++;
    
    let dbOk = true;
    let action = '';
    let details = '';
    
    // 1. 检查数据库连通性
    try {
      await this.db.playerDb.get('SELECT 1');
      this.heartbeat.stats.dbOkCount++;
    } catch (e) {
      dbOk = false;
      this.heartbeat.stats.dbFailCount++;
      details = `数据库检查失败: ${e.message}`;
      this.log('warn', `心跳：数据库检查失败 - ${e.message}`);
    }
    
    // 2. 检查模块完整性
    const expectedModules = Object.keys(this.moduleRegistry).length;
    const actualRooms = Object.keys(this.rooms).length;
    let modulesOk = true;
    if (expectedModules > 0 && actualRooms < expectedModules - 1) {  // 允许 core 不算 room 
      modulesOk = false;
      details += ` | 模块数不一致: registry=${expectedModules}, rooms=${actualRooms}`;
    }
    
    // 3. 处理失败 
    if (!dbOk) {
      this.heartbeat.consecutiveFails++;
      if (this.heartbeat.consecutiveFails >= this.heartbeat.maxFails) {
        action = 'reconnect_attempt';
        this.log('warn', `心跳连续失败 ${this.heartbeat.consecutiveFails} 次，尝试重连数据库`);
        await this._attemptReconnect();
      }
    } else {
      this.heartbeat.consecutiveFails = 0;
      if (this.heartbeat.stats.totalBeats === 1 || this.heartbeat.stats.totalBeats % 10 === 0) {
        this.log('info', `心跳 #${this.heartbeat.stats.totalBeats} 正常`);
      }
    }
    
    // 4. 记录心跳日志（异步，不阻塞） 
    setImmediate(async () => {
      try {
        await this.db.run(
          'INSERT INTO heartbeat_logs (beat_time, db_ok, modules_ok, action, details) VALUES (?, ?, ?, ?, ?)',
          [beatTime, dbOk ? 1 : 0, modulesOk ? 1 : 0, action, details]
        );
      } catch (e) { /* 忽略 */ }
    });
    
    setImmediate(() => {
      try { this.emit('core:heartbeat_ok', this.heartbeat.stats); } catch {} 
    });
    
    return { beatTime, dbOk, modulesOk, action, details };
  }

  async _attemptReconnect() {
    this.log('info', '尝试重连数据库...');
    try {
      // 关闭旧连接 
      if (this.db && this.db.unload) {
        try { await this.db.unload(); } catch {}
      }
      // 重新初始化数据库 
      const databaseModule = require('./databaseModule');
      this.db = await databaseModule(this);
      this.heartbeat.stats.reconnects++;
      this.heartbeat.consecutiveFails = 0;
      this.log('info', '数据库重连成功');
      setImmediate(() => {
        try { this.emit('core:reconnect', 'heartbeat'); } catch {} 
      });
    } catch (e) {
      this.log('error', `数据库重连失败: ${e.message}`);
    }
  }

  getHeartbeatStatus() {
    return {
      enabled: this.heartbeat.enabled,
      interval: this.heartbeat.interval,
      lastBeatTime: this.heartbeat.lastBeatTime,
      consecutiveFails: this.heartbeat.consecutiveFails,
      maxFails: this.heartbeat.maxFails,
      stats: { ...this.heartbeat.stats }
    };
  }

  async installModule(moduleName, filePath) {
    // 1. 检查是否已存在
    if (this.rooms[moduleName]) {
      return { success: false, error: `模块 ${moduleName} 已存在` };
    }
    
    // 2. 解析绝对路径
    const path = require('path');
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
    const fs = require('fs');
    if (!fs.existsSync(absPath)) {
      return { success: false, error: `文件不存在: ${absPath}` };
    }
    
    // 3. 动态 require（清缓存以支持重载）
    delete require.cache[require.resolve(absPath)];
    let moduleExport;
    try {
      moduleExport = require(absPath);
    } catch (e) {
      return { success: false, error: `加载失败: ${e.message}` };
    }
    
    // 4. 调用模块导出函数
    if (typeof moduleExport !== 'function') {
      return { success: false, error: `模块导出必须是函数` };
    }
    
    const prevFile = this._currentLoadingFile;
    this._currentLoadingFile = filePath;
    try {
      await moduleExport(this);
    } catch (e) {
      this._currentLoadingFile = prevFile;
      // 失败时清理已注册的房间
      if (this.rooms[moduleName]) delete this.rooms[moduleName];
      if (this.moduleRegistry[moduleName]) delete this.moduleRegistry[moduleName];
      return { success: false, error: `模块执行失败: ${e.message}` };
    }
    this._currentLoadingFile = prevFile;
    
    // 5. 同步门把手到数据库
    await this.syncCommandBindings();
    
    // 6. 触发事件
    setImmediate(() => {
      try { this.emit('core:module_installed', moduleName, this.moduleRegistry[moduleName]); } catch {} 
    });
    
    return { success: true, module: this.moduleRegistry[moduleName] };
  }

  _clearModuleMemoryOnly(moduleName) {
    for (const [trigger, binding] of Object.entries(this.doorHandles)) {
      if (binding.room === moduleName) delete this.doorHandles[trigger];
    }
    delete this.rooms[moduleName];
    delete this.moduleRegistry[moduleName];
    setImmediate(() => {
      try { this.emit('core:module_uninstalled', moduleName); } catch (e) {}
    });
  }

  async uninstallModule(moduleName) {
    const PROTECTED = ['core', 'player', 'database'];
    if (PROTECTED.includes(moduleName)) {
      return { success: false, error: `核心模块 ${moduleName} 不可卸载` };
    }
    
    if (!this.rooms[moduleName]) {
      return { success: false, error: `模块 ${moduleName} 不存在` };
    }
    
    // 1. 清除该模块的所有门把手（内存）
    for (const [trigger, binding] of Object.entries(this.doorHandles)) {
      if (binding.room === moduleName) {
        delete this.doorHandles[trigger];
      }
    }
    
    // 2. 从数据库删除该模块的门把手
    try {
      await this.db.run('DELETE FROM custom_commands WHERE room = ?', [moduleName]);
    } catch (e) {
      this.log('warn', `删除 custom_commands 失败: ${e.message}`);
    }
    
    // 3. 从数据库删除该模块的模板
    try {
      await this.db.run('DELETE FROM message_templates WHERE room = ?', [moduleName]);
    } catch (e) {
      this.log('warn', `删除 message_templates 失败: ${e.message}`);
    }
    
    // 4. 清除房间
    delete this.rooms[moduleName];
    
    // 5. 清除注册表
    delete this.moduleRegistry[moduleName];
    
    // 6. 触发事件
    setImmediate(() => {
      try { this.emit('core:module_uninstalled', moduleName); } catch {}
    });
    
    return { success: true };
  }

  async reloadModule(moduleName, explicitPath = null) {
    const info = this.moduleRegistry[moduleName];
    if (!info) {
      return { success: false, error: `模块 ${moduleName} 不存在` };
    }
    
    const filePath = explicitPath || info.file_path;
    if (!filePath || filePath === 'unknown') {
      return { success: false, error: `模块 ${moduleName} 无有效文件路径，无法重载。请手动指定：重载模块 ${moduleName} <路径>` };
    }
    const wasProtected = ['core', 'player', 'database'].includes(moduleName);
    
    // 如果是受保护模块，只重载代码不清注册 
    if (wasProtected) {
      // 直接重新 require 并执行，不卸载 
      const path = require('path');
      const absPath = path.isAbsolute(filePath) ? filePath : path.join(__dirname, '..', filePath);
      delete require.cache[require.resolve(absPath)];
      try {
        const mod = require(absPath);
        if (typeof mod === 'function') {
          // 清理旧房间（保留门把手数据库记录） 
          const oldBindings = {};
          for (const [trigger, binding] of Object.entries(this.doorHandles)) {
            if (binding.room === moduleName) {
              oldBindings[trigger] = binding;
            }
          }
          if (this.rooms[moduleName]) delete this.rooms[moduleName];
          await mod(this);
          return { success: true, module: this.moduleRegistry[moduleName] };
        }
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    
    // 普通模块：卸载 + 安装 
    this._clearModuleMemoryOnly(moduleName);
    return await this.installModule(moduleName, filePath);
  }

  // 以下旧的指令注册相关方法将被逐步废弃或移除
   // 暂时保留，但内部逻辑需调整或兼容新架构

  /**
   * 同步命令绑定：从数据库加载门把手配置，并处理模块的默认触发词
   */
  async syncCommandBindings() {
    if (!this.db) {
      this.log('warn', '数据库未连接，无法同步命令绑定。');
      return;
    }

    this.log('info', `正在同步 ${this._pendingBindings.length} 个待处理的命令绑定...`);
    const dbBindings = await this.db.getAllCustomCommands(); // 获取所有自定义命令，现在它包含了 room 和 logical_name (door)

    // 清空现有的门把手，重新构建
    this.doorHandles = {};

    // 1. 处理数据库中已有的绑定
    for (const dbCmd of dbBindings) {
      this.log('debug', `[syncCommandBindings] 处理数据库指令: ${dbCmd.trigger}, room: ${dbCmd.room}`);
      // room 为 customCommand 的指令由 customCommandModule 统一接管（逻辑委派/模板回退），
      // 核心不为其建立直接门把手 —— 2026-09-14 修复 打坐/问候/看血 路由失效
      if (dbCmd.room === 'customCommand') continue;
      this.doorHandles[dbCmd.trigger] = { // dbCmd.trigger 是 trigger
        room: dbCmd.room,
        door: dbCmd.logical_name, // logical_name 对应 door
        enabled: dbCmd.enabled === 1,
        description: dbCmd.description,
        aliases: dbCmd.aliases || [],
        template_key: dbCmd.template_key
      };
      // 注册别名
      if (dbCmd.aliases) {
        try {
          const aliases = this._parseAliases(dbCmd.aliases);
          aliases.forEach(alias => {
            if (!this.doorHandles[alias]) {
              this.doorHandles[alias] = { ...this.doorHandles[dbCmd.trigger], trigger: dbCmd.trigger }; // 别名指向主触发词的配置
            }
          });
        } catch (e) {
          this.log('error', `解析指令 ${dbCmd.name} 的别名失败: ${e.message}`);
        }
      }
    }

    // 2. 处理模块默认触发词：如果数据库中没有，则插入
    for (const pending of this._pendingBindings) {
      // 2026-09-20：customCommand 房的行**由 customCommandModule 自己管**（它从库读声明，
      // 决定这条指令是「绑模板 / 委托到别的逻辑 / 无逻辑走兜底」），核心这一步不该碰它们。
      // 为什么必须在这里挡：上面第 1041 行**主动跳过**了 room==='customCommand' 的库行
      //（它们不建 doorHandle），于是下面「!this.doorHandles[trigger]」对这类触发词**恒为真** ——
      // 核心每次启动都会走「插入」分支，用**模块注册的门把手名**（customCommand:<触发词>）
      // upsert 覆盖库里 defaultData 的声明，并把 template_key 写成 doorInfo.template_key || ''（空）。
      // 结果：「问候」绑不上模板、「看血」委托不到 player:role，三条示例指令全回兜底「指令已执行」。
      // 新装库不受影响：databaseModule 的 initDefaultData 会按 defaultData.commands 的正确声明补（只在缺失时插入）。
      if (!this.doorHandles[pending.trigger]) {
        // 数据库中不存在此触发词，从模块定义中获取更多信息插入
        const roomInfo = this.rooms[pending.room];
        const doorInfo = roomInfo?.doors[pending.door];

        if (roomInfo && doorInfo) {
          const newBinding = {
            trigger: pending.trigger,
            room: pending.room,
            logical_name: pending.door,
            enabled: 1, // 默认启用
            description: doorInfo.description || '',
            aliases: this._parseAliases(doorInfo.aliases || []),
            template_key: doorInfo.template_key || ''
          };
          // 2026-09-20：customCommand 房的行**不写库**。库里那几行的声明（绑哪个模板 / 委托到哪个逻辑）
          // 由 customCommandModule 和 databaseModule 的 initDefaultData 管；核心这里算出来的
          // logical_name 是**模块注册名**（customCommand:<触发词>）、template_key 是空的（customCommandModule
          // 注册门把手时没带这个字段），写进去就会把声明覆盖掉。而且上面 1041 行主动跳过了这类库行，
          // 于是这里每次启动都会走一遍 → 「问候」绑不上模板、「看血」委托不到 player:role，全回兜底。
          // ★ 注意：**内存里的 doorHandles 照建**（那几行在下面）—— 不建的话启动瞬间这些指令会变成
          //   「未知指令」（第一版就写成整个 continue 跳过，verify-custom-cmd-startup 当场抓到 4/8 打不通）。
          if (pending.room !== 'customCommand') await this.db.setCustomCommand(newBinding); // 插入到数据库
          this.doorHandles[pending.trigger] = { // 也添加到运行时门把手
            room: newBinding.room,
            door: newBinding.logical_name,
            enabled: true,
            description: newBinding.description,
            aliases: doorInfo.aliases || [],
            template_key: newBinding.template_key
          };
          this.log('debug', `[syncCommandBindings] 添加模块默认触发词到 doorHandles: ${pending.trigger}, room: ${pending.room}, door: ${pending.door}`);
          // 注册别名
          (doorInfo.aliases || []).forEach(alias => {
            if (!this.doorHandles[alias]) {
              this.doorHandles[alias] = { ...this.doorHandles[pending.trigger], trigger: pending.trigger };
            }
          });
        } else {
          this.log('warn', `同步命令绑定失败：模块 ${pending.room} 或门 ${pending.door} 未找到。`);
        }
      }
    }
    this.log('info', `命令绑定同步完成。共 ${Object.keys(this.doorHandles).length} 个门把手。`);
    this._pendingBindings = []; // 清空待处理队列
  }

  // --- 2. 指令注册与分发 ---

  /**
   * 注册一个指令逻辑处理器，但不立即绑定到具体命令名
   * @param {string} logicalName 逻辑唯一标识符 (例如 'player:register')
   * @param {Function} handler 处理函数
   * @param {Object} options 选项
   */
  /**
   * 注册一个指令逻辑处理器，但不立即绑定到具体命令名 (兼容旧架构)
   * @param {string} logicalName 逻辑唯一标识符 (例如 'player:register')
   * @param {Function} handler 处理函数
   * @param {Object} options 选项
   */
  registerLogicHandler(logicalName, handler, options = {}) {
    const moduleName = this.currentLoadingModule;
    if (!moduleName) {
      this.log('error', `尝试在模块外部注册逻辑处理器 ${logicalName}。`);
      throw new Error('逻辑处理器必须在模块加载期间注册。');
    }

    const doorDefinition = {
      logical_name: logicalName,
      default_triggers: options.triggers || [],
      aliases: options.aliases || [],
      description: options.description || '',
      permission: options.permission,
      cooldown: options.cooldown
    };

    if (this.rooms[moduleName]) {
      this.rooms[moduleName].doors[logicalName] = doorDefinition;
      this.rooms[moduleName].handlers[logicalName] = handler;
      for (const trigger of doorDefinition.default_triggers || []) {
        this._pendingBindings.push({ trigger, room: moduleName, door: logicalName });
      }
      for (const alias of doorDefinition.aliases || []) {
        this._pendingBindings.push({ trigger: alias, room: moduleName, door: logicalName });
      }
    } else {
      this.registerModule(moduleName, {
        doors: [doorDefinition],
        handlers: { [logicalName]: handler },
        templates: {}
      });
    }
    this.log('debug', `已通过兼容层注册逻辑处理器: ${logicalName} (模块: ${moduleName})`);
  }

  async handleCommand(playerId, rawText) {
    const op = { type: 'command', playerId, rawText };
    this.pendingOperations.add(op);

    try {
      let { trigger, args } = this._parseCommand(rawText);
      if (!trigger) {
        return this.handleError(new Error('指令格式无效'), { playerId, rawText });
      }

      // 1. 从 doorHandles 查找门把手
      let doorHandle = this.doorHandles[trigger];

      if (!doorHandle || !doorHandle.enabled) {
        this.log('warn', `未知指令或指令未启用: ${trigger}`);
        return this.handleError(new Error(`未知指令: ${trigger}`), { playerId, rawText });
      }

      // 2. 查找房间和门定义
      this.log('debug', `[handleCommand] 尝试查找房间: ${doorHandle.room}. 已注册房间: ${Object.keys(this.rooms).join(', ')}`);
      const room = this.rooms[doorHandle.room];
      if (!room) {
        this.log('error', `指令 ${trigger} 指向的房间 ${doorHandle.room} 不存在。`);
        return this.handleError(new Error(`系统错误：模块 ${doorHandle.room} 未加载。`), { playerId, rawText });
      }
      const door = room.doors[doorHandle.door];
      if (!door) {
        this.log('error', `房间 ${doorHandle.room} 中未找到门 ${doorHandle.door}。`);
        return this.handleError(new Error(`系统错误：指令处理器 ${doorHandle.door} 未定义。`), { playerId, rawText });
      }

      // 3. 查找处理器
      const handler = room.handlers[doorHandle.door];
      if (typeof handler !== 'function') {
        this.log('error', `门 ${doorHandle.door} 的处理器未注册或不是函数。`);
        return this.handleError(new Error(`系统错误：指令处理器 ${doorHandle.door} 未注册。`), { playerId, rawText });
      }

      this.log('debug', `分发指令: ${doorHandle.room}:${doorHandle.door}, 触发词: ${trigger}`);

      // 4. 组装请求对象
      const request = {
        playerId,
        commandText: rawText,
        trigger: trigger,
        args,
        room: doorHandle.room,
        door: doorHandle.door,
        doorInfo: door,
        doorHandle: doorHandle,
        core: this,
        engine: this,
        // 注入服务
        services: this.services
      };

      // 5. 依次执行中间件
      for (const mw of this.middlewares) {
        // 中间件可以修改 request 对象，或者抛出异常中断
        await mw(request);
      }

      // 6. 调用处理器
      const handlerResult = await handler(request);

      // 7. 根据 status 查找模板并渲染
      const status = handlerResult?.status || 'success';
      // 优先使用 handlerResult.templateKey，其次 doorHandle.template_key，最后 door.logical_name.status
      const templateKey = handlerResult?.templateKey || doorHandle.template_key || `${doorHandle.door}.${status}`;

      // DB-FIRST: 优先查 DB，DB 未命中再回退模块内存模板
      const keyVariants = [templateKey];
      const colonToDot = templateKey.replace(/:/g, '.');
      if (colonToDot !== templateKey && !keyVariants.includes(colonToDot)) keyVariants.push(colonToDot);
      const shortName = templateKey.split(':').pop();
      if (shortName !== templateKey && !keyVariants.includes(shortName)) keyVariants.push(shortName);
      const shortDot = shortName.replace(/:/g, '.');
      if (shortDot !== shortName && !keyVariants.includes(shortDot)) keyVariants.push(shortDot);
      if (templateKey.startsWith(doorHandle.room + '.')) {
        const noRoom = templateKey.slice(doorHandle.room.length + 1);
        if (noRoom && !keyVariants.includes(noRoom)) keyVariants.push(noRoom);
      }

      let templateContent = null;
      let matchedKey = templateKey;
      for (const k of keyVariants) {
        // 1) 先查当前房间
        let gt = await this.db.getMessageTemplate(doorHandle.room, k);
        // 2) 未命中且有前缀时，尝试跨房间（system.xxx 等通用模板）
        if (!gt && k.includes('.')) {
          const parts = k.split('.');
          const crossRoom = parts[0];
          const crossKey = parts.slice(1).join('.');
          if (crossRoom && crossRoom !== doorHandle.room) {
            const gt2 = await this.db.getMessageTemplate(crossRoom, crossKey);
            if (gt2 && gt2.text_content) { gt = gt2; }
          }
        }
        if (gt && gt.text_content) {
          templateContent = { text: gt.text_content, markdown: gt.markdown_content || gt.text_content };
          matchedKey = k;
          this.log('debug', `[handleCommand] DB 模板命中: ${k} in room ${doorHandle.room}`);
          break;
        }
      }

      if (!templateContent) {
        // 内存回退：遍历所有变体（冒号/点号/短名）
        for (const k of keyVariants) {
          if (room.templates && room.templates[k]) {
            templateContent = room.templates[k];
            matchedKey = k;
            this.log('debug', `[handleCommand] 内存模板命中: ${k}`);
            break;
          }
        }
        if (!templateContent) {
          this.log('warn', `模块 ${doorHandle.room} 未找到模板 ${templateKey}，DB 与内存中均无。`);
        }
      }
      this.log('debug', `[handleCommand] 最终 templateContent: ${JSON.stringify(templateContent)}`);
      
      const responseContext = {
        playerId,
        core: this,
        args,
        commandName: trigger,
        logicalName: doorHandle.door,
        templateName: templateKey, // 实际使用的模板键
        templateKey: templateKey, 
        moduleName: doorHandle.room, // 始终携带来源模块名
        doorHandle: doorHandle, // 便于模板访问门把手信息
        doorInfo: door,       // 便于模板访问门定义
        handlerResultData: handlerResult?.data || {}, // 处理器返回的数据
      };

      const formattedResponse = await this._formatResponse(
        // 图片模块（2026-09-16）：仅透传 type='image'，其它类型一律沿用全局模式推导结果。
        // 理由：superModule 等模块返回硬编码 type:'text'，若无条件透传，mode=2 下的 markdown 回复会被降级成纯文本。
        { content: handlerResult?.content || handlerResult, data: handlerResult?.data || {}, template: templateContent, type: handlerResult?.type === 'image' ? 'image' : undefined },
        responseContext
      );

      this.log('debug', `[handleCommand] _formatResponse 返回: ${JSON.stringify(formattedResponse)}`);
      return { ...formattedResponse, moduleName: doorHandle.room, door: doorHandle.door };

    } catch (err) {
      return this.handleError(err, { playerId, rawText });
    } finally {
      this.pendingOperations.delete(op);
    }
  }

  /**
   * 解析指令字符串，支持引号参数
   */
  _parseCommand(rawText) {
    const text = rawText.trim();
    this.log('debug', `[_parseCommand] 尝试解析指令: ${rawText}`);
    this.log('debug', `[_parseCommand] 门把手精确匹配: ${this.doorHandles[text] ? text : '无'}`);
    // 1. 精确匹配整个字符串
    if (this.doorHandles[text]) {
      return { trigger: text, args: [] };
    }
    // 2. 按长度从长到短尝试匹配前缀
    const triggers = Object.keys(this.doorHandles).sort((a, b) => b.length - a.length);
    for (const trigger of triggers) {
      if (text.startsWith(trigger + ' ') || text.startsWith(trigger)) {
        const rest = text.slice(trigger.length).trim();
        return { trigger, args: rest ? rest.split(/\s+/) : [] };
      }
    }
    // 3. 兜底：按空格拆分
    const parts = text.split(/\s+/);
    return { trigger: parts[0], args: parts.slice(1) };
  }

  /**
   * 将处理器结果渲染为最终消息格式
   */
  async _formatResponse(result, context) {
    const safeStringify = (v) => {
      try { return JSON.stringify(v); } catch (e) { return '[unserializable]'; }
    };
    const mode = this.getMessageMode();
    const modeMap = { 1: 'text', 2: 'markdown', 3: 'image' };
    
    // 默认类型始终跟随全局设置，除非结果对象显式要求覆盖
    let type = modeMap[mode] || 'text';
    let rawContent = result;
    let templateToRender = null; // 新增：用于存储要渲染的模板对象
    let isError = false;
    let code = null;
    let templateName = context.templateName || context.templateKey || '未知模板';

    // 如果返回的是对象
    if (result && typeof result === 'object') {
      // 提取内容
      rawContent = result.content !== undefined ? result.content : ''; // 内容可以为空
      isError = !!result.error;
      code = result.code;
      templateToRender = result.template; // 直接获取模板对象
      
      // 只有在明确指定了非默认 type 时才覆盖
      if (result.type) {
        type = result.type;
        templateName = result.templateName || templateName;
      }
      this.log('debug', `[_formatResponse] 从 result 对象提取: type=${type}, isError=${isError}, code=${code}, templateToRender=${!!templateToRender}, templateName=${templateName}`);
    }

    // 如果没有模板，但 rawContent 可能是纯字符串，则将其作为模板
    if (!templateToRender && typeof rawContent === 'string') {
      templateToRender = { text: rawContent, markdown: rawContent }; // 默认纯文本和markdown相同
      this.log('debug', `[_formatResponse] rawContent 作为模板fallback: ${rawContent.substring(0, 50)}...`);
    }

    // 获取对应渲染器，如果未注册则回退到 text 类型
    let renderer = this.messageTypes.get(type);
    if (!renderer) {
      this.log('warn', `未找到渲染器: ${type}，回退到 text`);
      type = 'text';
      renderer = this.messageTypes.get('text');
    }

    // 执行渲染
    const finalRenderData = { ...context, ...(result?.data || {}), message: result, templateKey: templateName };
// 执行渲染
    this.log('debug', `[_formatResponse] 调用渲染器: type=${type}, templateToRender=${(safeStringify(templateToRender) || '').substring(0, 50)}..., finalRenderData=${(safeStringify(finalRenderData) || '').substring(0, 50)}...`);
    const formattedContent = await renderer(templateToRender, finalRenderData);
    this.log('debug', `[_formatResponse] 渲染器返回 formattedContent: ${String(formattedContent ?? '').substring(0, 50)}...`);
    
    return {
      type: type,
      content: (formattedContent === undefined || formattedContent === null) ? '' : formattedContent,
      error: isError,
      code: code,
      templateName: templateName,
      data: (result && typeof result === 'object' && result.data) ? result.data : {}
    };
  }

  // --- 3. 事件系统 ---

  /**
   * 订阅事件
   */
  on(eventName, listener) {
    if (!this.events.has(eventName)) {
      this.events.set(eventName, new Set());
    }
    listener._moduleName = this.currentLoadingModule;
    this.events.get(eventName).add(listener);
  }

  /**
   * 单次订阅事件
   */
  once(eventName, listener) {
    const wrapper = async (...args) => {
      this.off(eventName, wrapper);
      try {
        return await listener(...args);
      } catch (err) {
        this.log('error', `单次监听器执行失败 [${eventName}]: ${err.message}`);
      }
    };
    wrapper._moduleName = this.currentLoadingModule;
    this.on(eventName, wrapper);
  }

  /**
   * 取消订阅
   */
  off(eventName, listener) {
    const listeners = this.events.get(eventName);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * 发布事件，支持通配符 :*
   */
  emit(eventName, ...args) {
    const listenerSet = new Set();
    this.log('debug', `触发事件: ${eventName}, 当前注册的事件: ${Array.from(this.events.keys()).join(', ')}`);
    
    // 精确匹配
    if (this.events.has(eventName)) {
      this.events.get(eventName).forEach(l => listenerSet.add(l));
    }

    // 通配符匹配 (例如 player:*)
    for (const [registeredName, listeners] of this.events.entries()) {
      if (registeredName.endsWith(':*')) {
        const prefix = registeredName.slice(0, -1);
        if (eventName.startsWith(prefix)) {
          listeners.forEach(l => listenerSet.add(l));
        }
      }
    }

    // 并行异步触发去重后的监听器
    for (const listener of listenerSet) {
      setImmediate(() => {
        Promise.resolve(listener(...args)).catch(err => {
          this.log('error', `事件监听器执行出错 [${eventName}]: ${err.message}`);
        });
      });
    }
  }

  // --- 4. 共享状态访问 ---

  /**
   * 获取在线玩家对象
   * @param {string} playerId 玩家 ID
   * @returns {Object|null} 玩家对象
   */
  getPlayer(playerId) {
    return this.state.players[playerId] || null;
  }

  /**
   * 确保玩家已注册，否则返回错误提示消息
   * @param {string} playerId 玩家 ID
   * @returns {Promise<Object|null>} 返回玩家对象或错误消息对象
   */
  async requirePlayer(playerId) {
    if (!this.db) {
      this.log('error', `数据库未连接，无法获取玩家数据: ${playerId}`);
      return { content: `系统错误：数据库未连接，无法获取玩家数据。`, error: true };
    }

    // 始终从数据库加载最新玩家数据
    let player = await this.db.getPlayer(playerId);

    if (player) {
      // 无论之前是否存在，都更新内存状态为最新数据
      this.updateState(`players.${playerId}`, player);
    } else {
      // 如果数据库中也不存在，则从内存中删除（如果存在的话）
      if (this.state.players[playerId]) {
        delete this.state.players[playerId];
        this.emit('state:changed', `players.${playerId}`, null); // 发送状态变更事件，表示玩家被移除
      }
    }

    if (!player) {
      const template = this.state.settings?.player_not_found_template || 
                       this.config.messages?.playerNotFound || 
                       "玩家 {playerId} 尚未注册，请先注册角色。";
      const content = await this.renderTemplate(template, { playerId });
      const mode = this.getMessageMode();
      const type = mode === 2 ? 'markdown' : 'text';
      return { type, content, error: true, code: 'PLAYER_NOT_FOUND' };
    }
    return player;
  }

  /**
   * 更新深层状态并触发变更事件
   */
  updateState(path, value) {
    const keys = path.split('.');
    let current = this.state;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!current[keys[i]]) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
    this.emit('state:changed', path, value);

    // 触发更具体的事件供任务系统等监听
    if (path.startsWith('players.')) {
      const parts = path.split('.');
      if (parts.length === 2) {
        // 更新的是整个玩家对象
        const playerId = parts[1];
        const player = value;
        
        // 触发所有关键属性变更事件
        const attrFields = ['生命', '生命上限', '魔法', '魔法上限', '攻击', '防御', '暴击率', '暴击伤害', '闪避率', '力量', '体质', '敏捷', '智力'];
        attrFields.forEach(f => {
          if (player[f] !== undefined) setImmediate(() => { this.emit('player:attribute_changed', playerId, f, player[f]); });
        });

        // 货币变更
        ['货币1', '货币2', '货币3'].forEach(f => {
          if (player[f] !== undefined) setImmediate(() => { this.emit('player:currency_changed', playerId, f, player[f]); });
        });

        // 特殊货币
        if (player.特殊货币 !== undefined) {
          setImmediate(() => { this.emit('player:special_currency_changed', playerId, player.特殊货币); });
        }
      } else if (parts.length === 3) {
        const playerId = parts[1];
        const field = parts[2];
        
        // 属性变化事件
        const attrFields = ['生命', '生命上限', '魔法', '魔法上限', '攻击', '防御', '暴击率', '暴击伤害', '闪避率', '力量', '体质', '敏捷', '智力'];
        if (attrFields.includes(field)) {
          setImmediate(() => { this.emit('player:attribute_changed', playerId, field, value); });
        }
        
        // 货币变化事件
        if (field.startsWith('货币')) {
          setImmediate(() => { this.emit('player:currency_changed', playerId, field, value); });
        }
        if (field === '特殊货币') {
          setImmediate(() => { this.emit('player:special_currency_changed', playerId, value); });
        }
      }
    }
  }

  // --- 5. 模板渲染工具 ---

  /**
   * 渲染模板字符串 (异步)
   * @param {string} template 模板字符串
   * @param {Object} data 数据源
   * @param {Object} options 渲染选项 { escape: true/false }
   * @param {string} playerId 玩家 ID (用于变量替换)
   */
  /**
   * 玩家业务字段的「规范名」解析（2026-09-19 · 覆盖校验 R8 修复）
   * ---------------------------------------------------------------
   * 实测的三个静默问题（都在「写玩家」这条路上）：
   *   ① player.modify 对不认识的字段照写不误 —— 写进内存对象，savePlayer 只写它认识的列，
   *      于是字段名打错既不报错也不落库，却回 { success: true }。
   *   ② giveCurrency 的 field 写别名「金币」（aliases 表里有这个别名）时，会往内存塞一个
   *      player['金币']，存库时丢掉 —— 钱凭空消失，同样回 success。
   *   ③ giveCurrency 扣成负数会直接把 -100 写进 player_currency。
   * 这里给出的判定：
   *   · `_` 开头的键是本框架既有约定（savePlayer 会把它收进 meta_json），放行；
   *   · 别名（aliases 表 alias→field）在这里归一；
   *   · 其余只认**玩家对象上真实存在**的字段（getPlayer 组装出来的那批），认不出返回 null 交调用方给人话。
   * 之所以从玩家对象上取字段表，而不是硬编码一份：核心以后加字段，这里自动跟上，不会两处漂移。
   * @param {object} player getPlayer 出来的玩家对象
   * @param {string} key 调用方写的字段名（可能是别名）
   * @returns {string|null} 规范字段名；null = 不认识
   */
  canonicalPlayerField(player, key) {
    const k = String(key == null ? '' : key).trim();
    if (!k) return null;
    if (k.charAt(0) === '_') return k;
    if (player && Object.prototype.hasOwnProperty.call(player, k)) return k;
    const mapped = this.inputAliases && this.inputAliases.get(k);
    if (mapped) return mapped;   // 别名归一（如 金币→货币1）；即使玩家对象上暂时没有这个键也认
    if (this.legacyPlayerFields && this.legacyPlayerFields.has(k)) return k;
    return null;
  }

  async renderTemplate(template, data = {}, options = { escape: true }, playerId = null, templateKey = null) {
    // 如果传入的是对象，根据消息模式选择模板
    if (typeof template === 'object' && template !== null) {
      const mode = this.getMessageMode();
      // 兼容数据库行对象(text_content/markdown_content)与标准模板对象(text/markdown)
      const _text = template.text || template.text_content || '';
      const _md = template.markdown || template.markdown_content || _text;
      template = mode === 2 ? (_md || _text) : (_text || _md);
    }
    if (!template || typeof template !== 'string') return '';
    this.log('debug', `[renderTemplate] 最终模板字符串 (前50字符): ${template.substring(0, 50)}...`);
    
    // 注入全局配置变量
    const contextData = {
      ...this.state.settings,
      ...data,
      game_name: this.state.settings?.game_name || 'WayGame'
    };

    let rendered = template;

    // 0. 属性别名替换 (必须在变量替换之前执行)
    // 按长度排序，优先替换长别名，防止子串误伤
    const sortedInputAliases = Array.from(this.inputAliases.entries())
      .filter(([alias, field]) => typeof alias === 'string' && field !== alias)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [alias, field] of sortedInputAliases) {
      // 转义别名中的特殊正则字符
      const escapedAlias = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // 替换方括号中的别名 (输入侧)
      // 例如 [玩家体力] -> [玩家生命]
      rendered = rendered.replace(new RegExp(`\\[(玩家|怪物|装备)?${escapedAlias}\\]`, 'g'), (match, prefix) => {
        return `[${prefix || ''}${field}]`;
      });
      
      // 替换大括号中的别名 (输入侧)
      // 例如 {体力} -> {生命}
      rendered = rendered.replace(new RegExp(`\\{${escapedAlias}(\\||\\})`, 'g'), `{${field}$1`);
    }

    // 1. 简单的条件判断 [if condition]...[/if] 或 {if condition}...{else}...{/if}
    // 增加对 [if]...[/if] 语法的支持，用于处理整行显示/隐藏
    // 修正正则以支持条件中包含 [变量] 的情况
    const ifRegex = /(?:\r?\n)?\[if\s+((?:\[.*?\]|[^\]])+)\]([\s\S]*?)\[\s*\/if\s*\](?:\r?\n)?/g;
    let ifMatch;
    let ifRendered = rendered;
    while ((ifMatch = ifRegex.exec(ifRendered)) !== null) {
      const condition = ifMatch[1];
      const content = ifMatch[2];
      const isTrue = await this._evaluateCondition(condition, contextData, playerId);
      
      let replacement = '';
      if (isTrue) {
        replacement = ifMatch[0].startsWith('\n') || ifMatch[0].startsWith('\r') ? '\n' + content : content;
      }
      
      ifRendered = ifRendered.substring(0, ifMatch.index) + replacement + ifRendered.substring(ifMatch.index + ifMatch[0].length);
      ifRegex.lastIndex = ifMatch.index + replacement.length;
    }
    rendered = ifRendered;

    const braceIfRegex = /\{if (.*?)\}([\s\S]*?)(?:\{else\}([\s\S]*?))?\{\/if\}/g;
    let braceIfMatch;
    let braceRendered = rendered;
    while ((braceIfMatch = braceIfRegex.exec(braceRendered)) !== null) {
      const condition = braceIfMatch[1];
      const thenBranch = braceIfMatch[2];
      const elseBranch = braceIfMatch[3];
      const isTrue = await this._evaluateCondition(condition, contextData, playerId);
      
      const replacement = isTrue ? thenBranch : (elseBranch || '');
      braceRendered = braceRendered.substring(0, braceIfMatch.index) + replacement + braceRendered.substring(braceIfMatch.index + braceIfMatch[0].length);
      braceIfRegex.lastIndex = braceIfMatch.index + replacement.length;
    }
    rendered = braceRendered;

    // 2. 递归扫描并替换方括号变量 [变量名] (异步支持)
    let maxIterations = 5;
    let lastRendered = '';
    while (maxIterations-- > 0 && rendered !== lastRendered) {
      lastRendered = rendered;
      const varRegex = /\[([\u4e00-\u9fa5\w]+)\]/g;
      const varMatches = [...rendered.matchAll(varRegex)];
      if (varMatches.length === 0) break;

      for (const match of varMatches) {
        const varName = match[1];
        // 传递 depth=0，因为 renderTemplate 本身处理递归
        let value = await this.getVariableValue(varName, playerId, 0, contextData);
        
        // 如果是 Markdown 模式，对变量内容进行转义 (防止破坏格式)
        if (this.getMessageMode() === 2 && typeof value === 'string') {
          // 挖出 qqbot 内嵌标签不转义
          const _tags = [];
          value = value.replace(/<qqbot-[^>]+>/g, (m) => { _tags.push(m); return '\uE100' + (_tags.length - 1) + '\uE101'; });
          value = value.replace(/([\\`*_{}[\]()#+-.!])/g, '\\$1');
          value = value.replace(/\uE100(\d+)\uE101/g, (_, i) => _tags[+i]);
        }

        if (value !== undefined && value !== match[0]) {
          // 包装标记，用于行级自动隐藏逻辑
          const markedValue = '\uE000' + (value === null ? '' : String(value)) + '\uE001';
          rendered = rendered.split(match[0]).join(markedValue);
        }
      }
    }

    // 2.5 $变量声明与引用（先处理，避免被后续 {} 替换覆盖）
    const localVars = {};
    const varDeclRe = /^\$([^\s=]+)\s*=\s*(.+?)\s*;?\s*$/gm;
    let varDeclM;
    while ((varDeclM = varDeclRe.exec(rendered)) !== null) {
      localVars[varDeclM[1]] = varDeclM[2].trim();
    }
    // 声明行从输出中移除（支持中文变量名）
    rendered = rendered.replace(/^\$[^\s=]+\s*=\s*.+?;?\s*$\n?/gm, '');
    // 逐个解析 $变量里的 {xxx} 数据源并替换引用
    const varKeys = Object.keys(localVars).sort((a, b) => b.length - a.length);
    for (const k of varKeys) {
      let resolved = localVars[k];
      const innerRe = /\{([^{}]+)\}/g;
      let innerM;
      while ((innerM = innerRe.exec(localVars[k])) !== null) {
        const p = innerM[1].trim().split('|')[0];
        let val = this._getValueByPath(contextData, p);
        if (val === undefined && p.includes('.')) {
          const seg = p.split('.');
          if (this._dataSources && this._dataSources.has(seg[0])) {
            if (seg.length === 3) {
              val = await this.resolveDataSource(seg[0], seg[1], seg[2], { core: this, playerId, data: contextData });
            } else if (seg.length === 2) {
              val = await this.resolveDataSource(seg[0], null, seg[1], { core: this, playerId, data: contextData });
            }
          }
        }
        if (val !== undefined) resolved = resolved.replace(innerM[0], String(val));
      }
      localVars[k] = resolved;
      const escK = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      rendered = rendered.replace(new RegExp('\\$' + escK, 'g'), () => resolved);
    }

    // 3. 变量替换与过滤器 (处理 {字段名})
    const braceRe = /\{([^{}]+)\}/g;
    const braceReplacements = [];
    let braceM;
    while ((braceM = braceRe.exec(rendered)) !== null) {
      const p1 = braceM[1];
      const parts = p1.split('|').map(s => s.trim());
      const path = parts[0];
      const pipes = parts.slice(1);
      let value = this._getValueByPath(contextData, path);
      // 新增：点号数据源解析（a.b / a.b.c）
      if (value === undefined && path.includes('.') && this._dataSources && this._dataSources.has(path.split('.')[0])) {
        const seg = path.split('.');
        if (seg.length === 3) {
          value = await this.resolveDataSource(seg[0], seg[1], seg[2], { core: this, playerId, data: contextData });
        } else if (seg.length === 2) {
          value = await this.resolveDataSource(seg[0], null, seg[1], { core: this, playerId, data: contextData });
        }
      }
      if (value === undefined) continue;
      braceReplacements.push({ raw: braceM[0], value, pipes });
    }
    for (const r of braceReplacements) {
      let value = r.value;
      // Markdown 模式自动转义（保留原行为）
      if (this.getMessageMode() === 2 && !r.pipes.includes('raw') && !r.pipes.includes('md_escape') && typeof value === 'string') {
        // 挖出 qqbot 内嵌标签不转义
        const _tags = [];
        value = value.replace(/<qqbot-[^>]+>/g, (m) => { _tags.push(m); return '\uE100' + (_tags.length - 1) + '\uE101'; });
        value = value.replace(/([\\`*_{}[\]()#+-.!])/g, '\\$1');
        value = value.replace(/\uE100(\d+)\uE101/g, (_, i) => _tags[+i]);
      }
      // 过滤器处理
      let rawWrap = false;
      for (const pipe of r.pipes) {
        if (pipe === 'uppercase') value = String(value).toUpperCase();
        else if (pipe === '大写') value = String(value).toUpperCase();
        else if (pipe === '格式化') value = this._formatNumber(value);
        else if (pipe === '加粗') value = '**' + value + '**';
        else if (pipe === '百分比') value = value + '%';
        else if (pipe === 'raw') rawWrap = true;
        else if (pipe === 'md_escape') {
          value = String(value).replace(/([\\`*_{}[\]()#+-.!])/g, '\\$1');
        }
      }
      let result = String(value);
      if (options.escape !== false && !rawWrap) {
        result = result.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      }
      rendered = rendered.replace(r.raw, () => '\uE000' + result + '\uE001');
    }

    // 4. 行级显式隐藏逻辑 ([if:变量名])
    let lines = rendered.split(/\r?\n/);
    let finalLines = [];
    
    for (let line of lines) {
      let keepRow = true;
      let hasExclamation = false;
      let lineToProcess = line;
      
      // 1. 处理 ! 强制保留前缀
      if (lineToProcess.trim().startsWith('!')) {
        hasExclamation = true;
        lineToProcess = lineToProcess.replace(/^\s*!/, '');
      }
      
      // 2. 解析行首 [if:变量名] 标记
      // 匹配行首的 [if:xxx]，注意标记可能在 ! 之后，也可能在 > 或 - 等 Markdown 标记之后
      const ifMarkerRegex = /^\s*(>|[-+*]|\d+\.)?\s*\[if:([^\]]+)\]/;
      const ifMatch = lineToProcess.match(ifMarkerRegex);
      
      if (ifMatch) {
        const prefix = ifMatch[1] || '';
        const varNames = ifMatch[2].split(',').map(s => s.trim());
        const marker = ifMatch[0];
        
        // 移除标记本身，保留前缀（如果有）
        lineToProcess = lineToProcess.replace(marker, prefix);
        
        // 如果没有强制保留标记，则进行条件判断
        if (!hasExclamation) {
          let allVariablesValid = true;
          for (const varName of varNames) {
            const val = await this.getVariableValue(varName, playerId, 0, contextData);
            if (val === undefined || val === null || String(val).trim() === '') {
              allVariablesValid = false;
              break;
            }
          }
          
          if (!allVariablesValid) {
            keepRow = false;
          }
        }
      }
      
      if (keepRow) {
        // 移除标记并保留行（同时清掉行尾/行内遗留的 [/if]）
        finalLines.push(lineToProcess
          .replace(/\[\s*\/if\s*\]/g, '')
          .replace(/\uE000/g, '')
          .replace(/\uE001/g, ''));
      }
    }
    rendered = finalLines.join('\n');

    // 5. 输出侧别名替换 (替换最终文本中的字段标签，如 "生命：" -> "体力：")
    // 建立 field -> alias 的映射，并按 field 长度倒序排列，防止子串误伤
    const sortedAttrAliases = Array.from(this.attributeAliases.entries())
      .filter(([field, alias]) => typeof field === 'string' && field !== alias)
      .sort((a, b) => b[0].length - a[0].length);

    for (const [field, alias] of sortedAttrAliases) {
      // 转义字段名中的特殊正则字符
      const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      
      // 简单全局替换，以支持“生命上限” -> “体力上限”这样的自动转换
      rendered = rendered.replace(new RegExp(escapedField, 'g'), alias);
    }

    return rendered;
  }

  /**
   * 从 URL 获取变量值
   */
  async _fetchVariableFromUrl(urlExpr, playerId) {
    try {
      // 支持 URL 中的变量替换
      const url = await this.renderTemplate(urlExpr, {}, { escape: false }, playerId);
      const res = await fetch(url);
      const text = await res.text();
      
      // 如果包含 JSON 解析路径 (例如 url|$.data.value)
      if (urlExpr.includes('|')) {
        const [targetUrl, jsonPath] = urlExpr.split('|');
        const data = JSON.parse(text);
        // 简单 JSON 路径解析
        return jsonPath.split('.').slice(1).reduce((acc, part) => acc && acc[part], data) || text;
      }
      return text;
    } catch (err) {
      this.log('warn', `从 URL 获取变量失败: ${urlExpr}. 错误: ${err.message}`);
      return `[ERROR: ${err.message}]`;
    }
  }

  /**
   * 获取消息模式 (1: 纯文本, 2: Markdown, 3: 图片)
   */
  getMessageMode() {
    return this.state.settings?.message_mode || 1;
  }

  /**
   * 数值格式化：10000 -> 1.0万，1e8 -> 1.00亿
   */
  _formatNumber(v) {
    const n = Number(v);
    if (isNaN(n)) return String(v);
    if (n < 10000) return String(n);
    if (n < 100000000) return (n / 10000).toFixed(1) + '万';
    return (n / 100000000).toFixed(2) + '亿';
  }

  /**
   * 通用 UI 子模板渲染
   * 走完整 renderTemplate 引擎：支持 {字段} / $变量 / [if:] / 数据源
   * 模块只负责传 data，格式由用户的模板决定
   */
  /**
   * 主动推送申请（模块调用）
   * @param {Object} options
   * @param {string} options.type       - 'player' | 'group' | 'broadcast'
   * @param {string} options.id         - 目标 ID（playerId 或 groupId）
   * @param {string} options.msg_type   - 'text' | 'markdown'（默认 markdown）
   * @param {string} options.content    - 直接内容（与 template 二选一）
   * @param {string} options.template   - 模板 key
   * @param {Object} options.data       - 模板渲染数据
   * @param {string} options.dedupe_key - 去重 key（可选）
   * @param {number} options.dedupe_window - 去重窗口秒数（默认 60）
   */
  /**
   * 推送模式（2026-09-17）：editor_settings.push_mode = 'pull' 时由插件端定时拉取，
   * 核心内置推送工人必须让路——否则新推送 5 秒内就被工人标成 sent/failed，插件永远拉不到。
   */
  async _isPullMode() {
    try {
      const row = await this.db.get("SELECT value FROM editor_settings WHERE key = 'push_mode'");
      return !!(row && String(row.value).trim().toLowerCase() === 'pull');
    } catch (e) { return false; }
  }

  _initPushWorker() {
    this._pushRunning = false;
    const tick = async () => {
      if (this._pushRunning) return;
      this._pushRunning = true;
      try {
        // 拉取模式：工人不发，交给插件端 POST /api/push/pull 自取
        if (await this._isPullMode()) return;
        const now = new Date().toISOString();
        const rows = await this.db.all(
          "SELECT * FROM push_queue WHERE status='pending' AND IFNULL(plugin_url,'') <> 'pull' AND (next_retry_at IS NULL OR next_retry_at <= ?) ORDER BY id ASC LIMIT 10",
          [now]
        );
        for (const row of rows) {
          await this._pushSend(row);
        }
      } catch (e) {
        this.log('warn', '[push-worker] tick 失败: ' + e.message);
      } finally {
        this._pushRunning = false;
      }
    };
    this._pushWorkerTick = tick;
    this._pushTimer = setInterval(tick, 5000);

    // 每天清理过期数据
    this._pushCleanTimer = setInterval(async () => {
      try {
        const expire = new Date(Date.now() - 30 * 86400_000).toISOString();
        const dedupeExpire = new Date(Date.now() - 3600_000).toISOString();
        await this.db.run("DELETE FROM push_queue WHERE status='sent' AND sent_at < ?", [expire]);
        await this.db.run("DELETE FROM push_dedupe WHERE pushed_at < ?", [dedupeExpire]);
        await this.db.run("DELETE FROM player_routes WHERE last_seen_at < ?", [expire]);
      } catch (e) {}
    }, 86400_000);
  }

  async _pushSend(row) {
    try {
      const body = JSON.stringify({
        type: row.type,
        id: row.target_id,
        msg_type: row.msg_type,
        content: row.content
      });
      const resp = await fetch(row.plugin_url + '/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        signal: AbortSignal.timeout(8000)
      });
      if (resp.ok) {
        await this.db.run(
          "UPDATE push_queue SET status='sent', sent_at=? WHERE id=?",
          [new Date().toISOString(), row.id]
        );
      } else {
        throw new Error('HTTP ' + resp.status);
      }
    } catch (e) {
      const retry = (row.retry_count || 0) + 1;
      const maxRetry = row.max_retry || 3;
      if (retry >= maxRetry) {
        await this.db.run(
          "UPDATE push_queue SET status='failed', retry_count=?, error=? WHERE id=?",
          [retry, e.message, row.id]
        );
      } else {
        const nextRetry = new Date(Date.now() + retry * 3000).toISOString();
        await this.db.run(
          "UPDATE push_queue SET retry_count=?, next_retry_at=?, error=? WHERE id=?",
          [retry, nextRetry, e.message, row.id]
        );
      }
    }
  }

  async push(options = {}) {
    const {
      type = 'player',
      id,
      msg_type = 'markdown',
      content,
      template,
      data = {},
      dedupe_key,
      dedupe_window = 60
    } = options;

    // 1. 内容准备
    let finalContent = content;
    if (!finalContent && template) {
      try {
        const seg = template.split('.');
        const row = await this.db.getMessageTemplate(seg[0], seg.slice(1).join('.'));
        if (row) {
          const tplStr = this.getMessageMode() === 2
            ? (row.markdown_content || row.text_content)
            : (row.text_content || row.markdown_content);
          finalContent = await this.renderTemplate(tplStr, data, { escape: false }, id);
        }
      } catch (e) { this.log('warn', '[push] 模板渲染失败: ' + e.message); }
    }
    if (!finalContent) return { ok: false, error: 'content empty' };

    // 2. 去重
    if (dedupe_key && id) {
      const now = new Date().toISOString();
      const exists = await this.db.get(
        'SELECT pushed_at FROM push_dedupe WHERE dedupe_key = ? AND player_id = ?',
        [dedupe_key, id]
      );
      if (exists) {
        const elapsed = (Date.now() - new Date(exists.pushed_at).getTime()) / 1000;
        if (elapsed < dedupe_window) return { ok: false, error: 'deduped', elapsed };
      }
      await this.db.run(
        'INSERT OR REPLACE INTO push_dedupe (dedupe_key, player_id, pushed_at) VALUES (?, ?, ?)',
        [dedupe_key, id, now]
      );
    }

    // 3. 查插件地址（拉取模式下统一记为 'pull'：工人跳过，由插件自取）
    const pullMode = await this._isPullMode();
    let pluginUrl = null;
    if (type === 'player') {
      const route = await this.db.get(
        'SELECT plugin_url FROM player_routes WHERE player_id = ?',
        [id]
      );
      if (!route) return { ok: false, error: 'no route' };
      pluginUrl = route.plugin_url;
    } else {
      const route = await this.db.get('SELECT plugin_url FROM player_routes LIMIT 1');
      pluginUrl = route ? route.plugin_url : null;
    }
    if (!pluginUrl) return { ok: false, error: 'no plugin url' };
    if (pullMode) pluginUrl = 'pull';

    // 4. 入队
    const now = new Date().toISOString();
    await this.db.run(
      'INSERT INTO push_queue (type, target_id, plugin_url, msg_type, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [type, id, pluginUrl, msg_type, finalContent, 'pending', now]
    );

    // 5. 触发 worker（拉取模式不触发，等插件来取）
    if (!pullMode && typeof this._pushWorkerTick === 'function') {
      setImmediate(() => this._pushWorkerTick());
    }
    return { ok: true };
  }

  async renderUiTpl(tpl, data = {}, playerId = null) {
    if (!tpl) return '';
    try {
      return await this.renderTemplate(tpl, data, { escape: false }, playerId);
    } catch (e) { this.log('warn', '[renderUiTpl] ' + e.message); return tpl; }
  }

  _getValueByPath(obj, path) {
    return path.split('.').reduce((acc, part) => {
      if (!acc) return undefined;
      if (acc[part] !== undefined) return acc[part];
      // 如果没找到，尝试通过别名反查原始字段名
      for (const [field, alias] of this.attributeAliases) {
        if (part === alias && acc[field] !== undefined) {
          return acc[field];
        }
      }
      return undefined;
    }, obj);
  }

  async _evaluateCondition(condition, data, playerId = null) {
    if (!condition || condition.trim() === '') return false;
    try {
      // 1. 在表达式中解析变量 (支持 [变量] 和 {变量})
      let expr = condition.trim();
      const context = { ...data, engine: this, core: this };

      // 使用异步解析变量，以支持系统变量 (如 [来源])
      const varRegex = /(\[([\u4e00-\u9fa5\w.]+)\]|\{([^{}]+)\})/g;
      const matches = Array.from(expr.matchAll(varRegex));
      
      for (const match of matches) {
        const fullMatch = match[0];
        const varName = match[2] || match[3];
        
        // 优先使用 getVariableValue 获取系统变量
        let val = await this.getVariableValue(varName, playerId, 0, context);
        
        // 如果返回的是占位符且 context 中有值，则取 context 中的值
        if (typeof val === 'string' && val === `[${varName}]`) {
          const directVal = this._getValueByPath(context, varName);
          if (directVal !== undefined) val = directVal;
        }

        // 新增：点号数据源解析 (如 玩家.等级 / 系统.货币1名 / 地图.新手村.简介)
        if ((val === undefined || val === null || val === '') && varName.includes('.') && this._dataSources) {
          const seg = varName.split('.');
          if (this._dataSources.has(seg[0])) {
            let dsVal;
            if (seg.length >= 3) {
              dsVal = await this.resolveDataSource(seg[0], seg[1], seg[2], { core: this, playerId, data: context });
            } else if (seg.length === 2) {
              dsVal = await this.resolveDataSource(seg[0], null, seg[1], { core: this, playerId, data: context });
            }
            if (dsVal !== undefined) val = dsVal;
          }
        }

        // 处理数组/对象为字符串
        if (Array.isArray(val)) val = val.join(',');
        
        // 如果是字符串，加上引号；如果是空或未定义，设为 null
        let replacement;
        if (typeof val === 'string') {
          // 如果 val 本身就是 "[变量名]" (未定义的变量)，在条件判断中视为 null
          if (val === fullMatch || val === `[${varName}]`) {
            replacement = 'null';
          } else {
            replacement = `"${val.replace(/"/g, '\\"')}"`;
          }
        } else if (val === undefined || val === null) {
          replacement = 'null';
        } else {
          replacement = val;
        }
        
        expr = expr.split(fullMatch).join(String(replacement));
      }

      this.log('debug', `Condition evaluation: "${condition}" -> "${expr}"`);
      if (expr.endsWith('存在')) {
        const varPart = expr.replace('存在', '').trim();
        return varPart !== 'null' && varPart !== 'undefined' && varPart !== '""';
      }

      // 中文运算符替换（且/或/非），放在 空 比较之前
      expr = expr.replace(/且/g, '&&').replace(/或/g, '||').replace(/非/g, '!');
      
      // 中文逻辑运算符替换（且/或/非）
      expr = expr.replace(/且/g, '&&').replace(/或/g, '||').replace(/非/g, '!');

      // 简单替换 == 空 和 != 空
      // 注意：此时 expr 可能是 "值" == 空
      expr = expr
        .replace(/==\s*空|是\s*空/g, ' == null || (typeof($0) !== "undefined" && $0 == "")')
        .replace(/!=\s*空|非\s*空/g, ' != null && (typeof($0) !== "undefined" && $0 != "")');
      
      // 我们需要为 $0 提供一个值，或者干脆不用它
      // 更好的方式是直接处理比较
      if (expr.includes('== null') || expr.includes('!= null')) {
        // 提取左值
        const leftValue = expr.split(/[=!]=/).shift().trim();
        const isEquals = expr.includes('==');
        const func = new Function('data', `with(data) { try { const val = ${leftValue}; return ${isEquals} ? (val == null || val == "") : (val != null && val != ""); } catch(e) { return ${!isEquals}; } }`);
        return !!func(context);
      }

      // 3. 尝试作为 JS 表达式执行
      const func = new Function('data', `with(data) { try { return ${expr}; } catch(e) { return false; } }`);
      return !!func(context);
    } catch (e) {
      return false;
    }
  }

  // --- 6. 日志与错误处理 ---

  /**
   * 统一日志输出，支持文件持久化
   */
  async log(level, message, meta = {}) {
    // 检查日志级别
    const levels = { 'debug': 0, 'info': 1, 'warn': 2, 'error': 3, 'none': 4 };
    const configLevel = levels[this.config.logLevel || 'info'] || 1;
    const currentLevel = levels[level.toLowerCase()];
    
    if (currentLevel < configLevel) return;

    const timestamp = new Date().toISOString();
    const logText = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    
    // 控制台输出 - Windows 下强制 UTF-8 输出以修复中文乱码
    if (process.platform === 'win32') {
      const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      process.stdout.write(logText + metaStr + '\n', 'utf8');
    } else {
      console.log(logText, Object.keys(meta).length ? meta : '');
    }
    
    // 文件输出
    if (this.config.logFile) {
      try {
        fs.appendFile(this.config.logFile, logText + '\n').catch(() => {});
      } catch (err) {
        // Windows 下错误输出也使用 process.stderr.write
        if (process.platform === 'win32') {
          process.stderr.write(`无法写入日志文件: ${err.message}\n`, 'utf8');
        } else {
          console.error('无法写入日志文件:', err.message);
        }
      }
    }
  }

  /**
   * 捕获并处理异常
   */
  handleError(err, context = {}) {
    this.log('error', err.message, { stack: err.stack, ...context });
    
    // 如果是开发模式或沙盒调试，返回更详细的错误信息
    const friendlyMessage = err.code 
      ? this._getFriendlyMessage(err.code) 
      : (err.message || "系统繁忙，请稍后再试");
      
    const mode = this.getMessageMode();
    const type = mode === 2 ? 'markdown' : 'text';
    return { type, content: friendlyMessage, error: true, code: err.code };
  }

  _getFriendlyMessage(code) {
    const messages = {
      'AUTH_FAILED': '权限不足，无法执行此操作。',
      'COOLDOWN': '操作太频繁了，请稍后再试。',
    };
    return messages[code] || "操作未能完成。";
  }

  /**
   * 内部方法：基础权限检查
   */
  _checkPermission(playerId, permission) {
    const player = this.state.players[playerId];
    if (!player) return false;
    if (permission === 'admin') return !!player.isAdmin;
    if (permission === 'player') return true;
    return Array.isArray(player.permissions) && player.permissions.includes(permission);
  }

  // --- 7. 生命周期管理 ---

  /**
   * 启动核心引擎
   * @param {Object} options 启动选项，包括 modules 和 databaseModule
   */
  async start({ modules = [], databaseModule = null } = {}) {
    try {
      this.log('info', '正在启动游戏核心引擎...');
      
      // 1. 初始化持久化状态
      await this.loadState();
      
      // 2. 初始化数据库（如果提供）
      // 2. 初始化数据库（如果提供）
      if (databaseModule) {
        if (typeof databaseModule === 'function') {
          // If databaseModule is the function itself, load it.
          // This call will internally set core.db = db and register 'database' in this.modules
          this.log('info', '正在通过函数加载数据库模块...');
          await this.loadModule(databaseModule);
        } else if (typeof databaseModule === 'object' && databaseModule !== null) {
          // If databaseModule is an object, it means DatabaseModule(core) was already called externally.
          // In this case, core.db should have already been set by databaseModule.js.
          // We only need to ensure it's registered in this.modules if it isn't already.
          if (!this.modules.has('database') && this.db) { // Check if this.db is set from external call
            this.log('info', '数据库模块已作为外部实例提供，正在确保注册...');
            this.modules.set('database', {
              func: () => this.db, // Reference the already set this.db
              cleanup: this.db.unload || null,
              exports: this.db
          });
          } else if (this.db) {
            this.log('info', '数据库模块已通过外部调用初始化并注册，跳过。');
          } else {
             this.log('warn', '提供的 databaseModule 参数是一个实例，但核心db未设置，跳过处理。');
          }
        } else {
          this.log('warn', '提供的 databaseModule 参数类型异常，跳过数据库初始化。');
        }
      } else if (this.modules.has('database')) {
        this.log('info', '数据库模块已通过其他方式初始化，跳过。');
      }

      // 3. 注册系统变量 (在加载模块前注册，确保模块初始化时可用)
      this._registerSystemVariables();
      try { this._initPushWorker(); } catch (e) { this.log('warn', '[push-worker] 初始化失败: ' + e.message); }

      // 3.5 初始化模板数据源机制（注册"系统"与"参数"两个内置数据源）
      try {
        require('./templateDataSource')(this);
      } catch (e) {
        this.log('warn', '[dataSource] 初始化失败: ' + e.message);
      }

      // 确保模块能通过 core.xxx 访问 
      this.services = this.services || {}; 
      this.services.player = this.services.player || this.playerService; 
      this.services.query = this.services.query || this.queryService; 
      if (!this.requirePlayer) { 
        this.requirePlayer = async (playerId) => { 
          if (!this.db) return { error: true, content: '数据库未连接' }; 
          const player = await this.db.getPlayer(playerId); 
          if (!player) return { error: true, content: '玩家不存在' }; 
          return player; 
        }; 
      }

      // 4. 加载初始模块
      if (modules.length > 0) {
        this.log('info', '正在加载初始模块列表...');
        await this.loadModules(modules);
      }

      // 5. 数据库就绪后加载别名持久化数据
      await this._loadAliasesFromDatabase();

      // 6. 加载自定义变量持久化数据
      await this._loadVariablesFromDatabase();

      // 7. 初始化编辑器数据加载与热更新
      await this._initDataEditor();

      // 注册核心自带的房间
      this.registerModule('core', {
        version: '1.0.0',
        doors: [
          { logical_name: 'core:module_list', default_triggers: ['模块列表', 'modules'] },
          { logical_name: 'core:module_info', default_triggers: ['模块信息', 'module_info'] },
          { logical_name: 'core:install_module', default_triggers: ['安装模块', 'install_module'] },
          { logical_name: 'core:uninstall_module', default_triggers: ['卸载模块', 'uninstall_module'] },
          { logical_name: 'core:reload_module', default_triggers: ['重载模块', 'reload_module'] },
          { logical_name: 'core:heartbeat_status', default_triggers: ['心跳状态', 'heartbeat'] },
          { logical_name: 'core:heartbeat_beat', default_triggers: ['手动心跳', 'beat'] },
          { logical_name: 'core:heartbeat_toggle', default_triggers: ['心跳开关', 'toggle_heartbeat'] }
        ],
        templates: {
          'core:module_list.success': {
            text: '📦 【模块列表】（共 [总数] 个）\n[列表数据]',
            markdown: '📦 **【模块列表】**（共 [总数] 个）\n[列表数据]'
          },
          'core:module_list.empty': {
            text: '当前没有任何已注册模块。',
            markdown: '当前没有任何已注册模块。',
          },
          'core:module_info.success': {
            text: '📦 【模块：[模块名]】\n状态：[状态]\n版本：[版本]\n加载时间：[加载时间]\n门数：[门数]\n模板数：[模板数]\n处理器数：[处理器数]\n文件：[文件路径]',
            markdown: '📦 **【模块：[模块名]】**\n状态：[状态]\n版本：[版本]\n加载时间：[加载时间]\n门数：[门数]\n模板数：[模板数]\n处理器数：[处理器数]\n文件：[文件路径]'
          },
          'core:module_info.not_found': {
            text: '模块 [模块名] 不存在。',
            markdown: '模块 **[模块名]** 不存在。'
          },
          'core:install_module.success': { text: '✅ 模块 [模块名] 安装成功。\n门数：[门数]，模板数：[模板数]', markdown: '✅ 模块 **[模块名]** 安装成功。\n门数：[门数]，模板数：[模板数]' },
          'core:install_module.fail': { text: '❌ 安装失败：[错误信息]', markdown: '❌ 安装失败：**[错误信息]**' },
          'core:uninstall_module.success': { text: '✅ 模块 [模块名] 已卸载。', markdown: '✅ 模块 **[模块名]** 已卸载。' },
          'core:uninstall_module.fail': { text: '❌ 卸载失败：[错误信息]', markdown: '❌ 卸载失败：**[错误信息]**' },
          'core:reload_module.success': { text: '✅ 模块 [模块名] 已重载。', markdown: '✅ 模块 **[模块名]** 已重载。' },
          'core:reload_module.fail': { text: '❌ 重载失败：[错误信息]', markdown: '❌ 重载失败：**[错误信息]**' },
          'core:heartbeat_status.success': { text: '💓 【心跳状态】\n状态：[状态]\n间隔：[间隔]秒\n最近心跳：[最近心跳]\n连续失败：[连续失败]次\n总心跳：[总心跳次]\n数据库成功：[数据库成功]\n数据库失败：[数据库失败]\n重连次数：[重连次数]', markdown: '💓 **【心跳状态】**\n状态：[状态]\n间隔：[间隔]秒\n最近心跳：[最近心跳]\n连续失败：[连续失败]次\n总心跳：[总心跳次]\n数据库成功：[数据库成功]\n数据库失败：[数据库失败]\n重连次数：[重连次数]' },
          'core:heartbeat_beat.success': { text: '💓 心跳执行完成。\n数据库：[数据库]\n模块：[模块]\n动作：[动作]', markdown: '💓 心跳执行完成。\n数据库：[数据库]\n模块：[模块]\n动作：[动作]' },
          'core:heartbeat_toggle.success': { text: '💓 心跳检查器已[操作]。', markdown: '💓 心跳检查器已**[操作]**。' }
        },
        handlers: {
          'core:module_list': async (request) => {
            const modules = request.core.listModules();
            if (modules.length === 0) {
              return { status: 'success', data: {}, templateKey: 'core:module_list.empty' };
            }
            const lines = modules.map(m =>
              `▫️ ${m.module_name} [${m.status}] v${m.version} (门:${m.doors.length}, 模板:${m.templates_count})`
            ).join('\n');
            return {
              status: 'success',
              data: { 总数: modules.length, 列表数据: lines },
              templateKey: 'core:module_list.success'
            };
          },
          'core:module_info': async (request) => {
            const name = request.args[0];
            if (!name) return { status: 'fail', data: { 模块名: '未指定' }, templateKey: 'core:module_info.not_found' };
            const info = request.core.getModuleInfo(name);
            if (!info) return { status: 'fail_not_found', data: { 模块名: name }, templateKey: 'core:module_info.not_found' };
            return {
              status: 'success',
              data: {
                模块名: info.module_name,
                状态: info.status,
                版本: info.version,
                加载时间: info.loaded_at,
                门数: info.doors.length,
                模板数: info.templates_count,
                处理器数: info.handlers_count,
                文件路径: info.file_path
              },
              templateKey: 'core:module_info.success'
            };
          },
          'core:install_module': async (request) => {
            const name = request.args[0];
            const filePath = request.args[1];
            if (!name || !filePath) {
              return { status: 'fail', data: { 错误信息: '用法：安装模块 <模块名> <文件路径>' }, templateKey: 'core:install_module.fail' };
            }
            const result = await request.core.installModule(name, filePath);
            if (!result.success) {
              return { status: 'fail', data: { 错误信息: result.error }, templateKey: 'core:install_module.fail' };
            }
            return {
              status: 'success',
              data: {
                模块名: name,
                门数: result.module.doors.length,
                模板数: result.module.templates_count
              },
              templateKey: 'core:install_module.success'
            };
          },
          'core:uninstall_module': async (request) => {
            const name = request.args[0];
            if (!name) {
              return { status: 'fail', data: { 错误信息: '用法：卸载模块 <模块名>' }, templateKey: 'core:uninstall_module.fail' };
            }
            const result = await request.core.uninstallModule(name);
            if (!result.success) {
              return { status: 'fail', data: { 错误信息: result.error }, templateKey: 'core:uninstall_module.fail' };
            }
            return { status: 'success', data: { 模块名: name }, templateKey: 'core:uninstall_module.success' };
          },
          'core:reload_module': async (request) => {
            const name = request.args[0];
            if (!name) {
              return { status: 'fail', data: { 错误信息: '用法：重载模块 <模块名>' }, templateKey: 'core:reload_module.fail' };
            }
            const result = await request.core.reloadModule(name);
            if (!result.success) {
              return { status: 'fail', data: { 错误信息: result.error }, templateKey: 'core:reload_module.fail' };
            }
            return { status: 'success', data: { 模块名: name }, templateKey: 'core:reload_module.success' };
          },
          'core:heartbeat_status': async (request) => {
            const s = request.core.getHeartbeatStatus();
            return {
              status: 'success',
              data: {
                状态: s.enabled ? '运行中' : '已停止',
                间隔: Math.floor(s.interval / 1000),
                最近心跳: s.lastBeatTime || '尚未执行',
                连续失败: s.consecutiveFails,
                总心跳次: s.stats.totalBeats,
                数据库成功: s.stats.dbOkCount,
                数据库失败: s.stats.dbFailCount,
                重连次数: s.stats.reconnects
              },
              templateKey: 'core:heartbeat_status.success'
            };
          },
          'core:heartbeat_beat': async (request) => {
            const r = await request.core.beat();
            return {
              status: 'success',
              data: {
                数据库: r.dbOk ? '正常' : '异常',
                模块: r.modulesOk ? '正常' : '异常',
                动作: r.action || '无'
              },
              templateKey: 'core:heartbeat_beat.success'
            };
          },
          'core:heartbeat_toggle': async (request) => {
            const s = request.core.getHeartbeatStatus();
            if (s.enabled) {
              request.core.stopHeartbeat();
              return { status: 'success', data: { 操作: '停止' }, templateKey: 'core:heartbeat_toggle.success' };
            } else {
              request.core.startHeartbeat();
              return { status: 'success', data: { 操作: '启动' }, templateKey: 'core:heartbeat_toggle.success' };
            }
          }
        }
      });

      // 7. 同步命令绑定（门把手）
      await this.syncCommandBindings();

      // 8. 触发启动事件
      await this.emit('core:started');
      this.log('info', '游戏核心引擎启动成功。');

      // 9. 启动心跳检查器
      this.startHeartbeat({ interval: 30000, maxFails: 3 });

    } catch (err) {
      this.log('error', `核心引擎启动失败: ${err.message}`);
      await this.stop();
      throw err;
    }
  }

  /**
   * 初始化数据编辑器集成逻辑
   */
  async _initDataEditor() {
    this.dataEditor = {
      reloadData: async () => {
        this.log('info', '正在热更新编辑器数据...');
        await this._loadGameDataFromDatabase();
        await this.emit('data:reloaded');
        this.log('info', '编辑器数据热更新完成。');
      }
    };

    // 首次启动：检查并写入默认设置
      // 默认设置现在由 databaseModule 的 initDefaultData 处理，此处仅加载
    
      // 加载所有游戏数据到 core.state
    await this._loadGameDataFromDatabase();
  }

  /**
   * 从数据库加载所有游戏数据到 state
   */
  async _loadGameDataFromDatabase() {
    if (!this.db) return;

    // 1. 加载设置
    this.state.settings = await this.db.getAllEditorSettings();
    
    // 同步货币名称到属性别名
    if (this.state.settings) {
      const s = this.state.settings;
      // 只有当设置的名称与字段名不同时，才更新别名映射，避免覆盖已有的自定义别名
      if (s.currency_1_name && s.currency_1_name !== '金币') this.attributeAliases.set('金币', s.currency_1_name);
      if (s.currency_2_name && s.currency_2_name !== '银币') this.attributeAliases.set('银币', s.currency_2_name);
      if (s.currency_3_name && s.currency_3_name !== '铜币') this.attributeAliases.set('铜币', s.currency_3_name);
      if (s.special_currency_name && s.special_currency_name !== '特殊货币') this.attributeAliases.set('特殊货币', s.special_currency_name);
    }

    // 2. 加载地图
    const maps = await this.db.getAllMaps();
    if (maps.length > 0) {
      const mapObj = {};
      maps.forEach(m => mapObj[m.name] = m);
      this.updateState('world.maps', mapObj);
    }

    // 3. 加载怪物
    const monsters = await this.db.getAllMonsters();
    if (monsters.length > 0) {
      const monsterObj = {};
      monsters.forEach(m => monsterObj[m.name] = m);
      this.state.monsters = monsterObj;
    }

    // 4. 加载物品
    const items = await this.db.getAllItems();
    if (items.length > 0) {
      const itemObj = {};
      items.forEach(i => itemObj[i.name] = i);
      this.state.items = itemObj;
    }

    // 5. 加载装备
    const equipment = await this.db.getAllEquipment();
    if (equipment.length > 0) {
      const equipObj = {};
      equipment.forEach(e => {
        // 确保装备定义中包含 category 字段，用于核心逻辑识别
        e.category = '装备';
        equipObj[e.name] = e;
      });
      this.state.equipmentDefinitions = equipObj;
    }

    // 6. 加载商店
    const shops = await this.db.getAllShops();
    if (shops.length > 0) {
      const shopObj = {};
      shops.forEach(s => shopObj[s.name] = s);
      this.state.shops = shopObj;
    }

    // 7. 加载 NPC
    const npcs = await this.db.getAllNpcs();
    if (npcs.length > 0) {
      const npcObj = {};
      npcs.forEach(n => npcObj[n.name] = n);
      this.state.npcs = npcObj;
    }

    // 8. 加载消息模板 (现在通过 message_templates 表或模块 room 定义获取，这里不再加载到 state.templates)
    // const templates = await this.db.getAllMessageTemplates();
    // if (templates.length > 0) {
    //   const templateObj = {};
    //   templates.forEach(t => templateObj[t.key] = t.template);
    //   this.state.templates = templateObj;
    //   this.config.templates = { ...this.config.templates, ...templateObj };
    // }

    // 9. 加载自定义指令状态 (现在由 syncCommandBindings 处理，此处不再加载到 state.customCommands)
    // const commands = await this.db.getAllCustomCommands();
    // this.state.customCommands = commands;
    
    // 绑定自定义指令到逻辑处理器 (此方法已移除)
    // this._registerCustomCommands();
  }



  /**
   * 停止核心引擎，确保资源安全释放
   */
  async stop() {
    this.log('info', '正在关闭游戏核心引擎...');

    this.stopHeartbeat(); // 停止心跳
    if (this._pushTimer) { clearInterval(this._pushTimer); this._pushTimer = null; }
    if (this._pushCleanTimer) { clearInterval(this._pushCleanTimer); this._pushCleanTimer = null; }
    
    try {
      // 1. 触发停止中事件
      await this.emit('core:stopping');

      // 2. 等待进行中的异步操作完成（带超时限制）
      if (this.pendingOperations.size > 0) {
        this.log('info', `等待 ${this.pendingOperations.size} 个进行中的任务完成...`);
        const timeout = new Promise(resolve => setTimeout(resolve, this.config.stopTimeout));
        const allDone = Promise.all(Array.from(this.pendingOperations));
        await Promise.race([allDone, timeout]);
      }

      // 3. 保存最终状态
      await this.saveState();

      // 4. 卸载所有模块
      const moduleNames = Array.from(this.modules.keys());
      for (const name of moduleNames) {
        await this.unloadModule(name);
      }

      // 5. 触发已停止事件
      await this.emit('core:stopped');
      this.log('info', '游戏核心引擎已安全关闭。');
    } catch (err) {
      this.log('error', `关闭核心引擎时发生错误: ${err.message}`);
    }
  }

  // --- 8. 中间件 ---

  /**
   * 注册指令中间件
   * @param {Function} fn 中间件函数，签名 (request) => Promise<void>
   */
  registerMiddleware(fn) {
    fn._moduleName = this.currentLoadingModule;
    this.middlewares.push(fn);
  }

  // --- 10. 状态持久化 ---

  /**
   * 保存当前状态到文件
   */
  async saveState() {
    if (!this.config.savePath) return;
    try {
      const data = JSON.stringify(this.state, null, 2);
      await fs.writeFile(this.config.savePath, data);
      this.log('info', '游戏状态保存成功。');
    } catch (err) {
      this.log('error', `保存状态失败: ${err.message}`);
    }
  }

  /**
   * 从文件加载状态并执行版本检查
   */
  async loadState() {
    if (!this.config.savePath) return;
    try {
      const data = await fs.readFile(this.config.savePath, 'utf-8');
      const loadedState = JSON.parse(data);
      
      // 版本检查逻辑
      if (loadedState._version && loadedState._version !== this.config.version) {
        this.log('warn', `检测到状态版本不一致: 当前 ${this.config.version}, 文件 ${loadedState._version}。尝试迁移...`);
        // 此处可添加迁移逻辑
      }
      
      this.state = { ...this.state, ...loadedState };
      this.log('info', '游戏状态加载成功。');
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.log('info', '未找到持久化状态文件，将使用初始状态。');
      } else {
        this.log('warn', `加载状态失败: ${err.message}`);
      }
    }
  }

  // --- 11. 消息类型注册 ---

  /**
   * 注册自定义消息渲染器
   */
  registerMessageType(type, renderer) {
    this.messageTypes.set(type, renderer);
  }

  /**
   * 设置或更新字段别名
   * @param {string} field 原始字段名
   * @param {string} alias 别名
   * @param {boolean} persist 是否持久化到数据库 (默认为 true)
   */
  setAlias(field, alias, persist = true) {
    // 1. 设置优先显示别名 (1:1)
    this.attributeAliases.set(field, alias);
    
    // 2. 增加输入别名映射 (N:1)
    this.inputAliases.set(alias, field);
    
    // 异步持久化到数据库
    if (persist && this.db) {
      this.db.saveAlias(field, alias).catch(err => {
        this.log('warn', `持久化别名 ${field} -> ${alias} 失败: ${err.message}`);
      });
    }
  }

  /**
   * 显式持久化别名到数据库
   */
  async persistAlias(field, alias) {
    if (!this.db) {
      this.log('warn', '数据库未连接，无法持久化别名。');
      return;
    }
    try {
      await this.db.saveAlias(field, alias);
      this.setAlias(field, alias, false);
    } catch (err) {
      this.log('error', `保存别名 ${field} 到数据库失败: ${err.message}`);
      throw err;
    }
  }

  /**
   * 从数据库加载别名
   */
  async _loadAliasesFromDatabase() {
    this.log('debug', `尝试从数据库加载别名。当前 db 状态: ${!!this.db}`);
    if (!this.db) return;
    try {
      const rows = await this.db.all('SELECT field, alias FROM aliases WHERE enabled = 1');
      for (const row of rows) {
        // 加载时不重复持久化，避免启动时的锁竞争和冗余写入
        this.setAlias(row.field, row.alias, false);
      }
      this.log('info', `从数据库加载了 ${rows.length} 条别名映射。`);
    } catch (err) {
      this.log('warn', `从数据库加载别名失败: ${err.message}`);
    }
  }

  /**
   * 注册系统变量
   */
  registerSystemVariable(name, getter, aliases = []) {
    this.systemVariables.set(name, { getter, aliases });
    aliases.forEach(alias => {
      this.systemVariables.set(alias, { getter, isAlias: true, mainName: name });
    });
  }

  /**
   * 移除系统变量
   */
  removeSystemVariable(name) {
    const sysVar = this.systemVariables.get(name);
    if (!sysVar) return;

    if (sysVar.isAlias) {
      // 如果是别名，只移除该别名
      this.systemVariables.delete(name);
    } else {
      // 如果是主变量，移除自身及其所有别名
      if (sysVar.aliases) {
        sysVar.aliases.forEach(alias => this.systemVariables.delete(alias));
      }
      this.systemVariables.delete(name);
    }
  }

  /**
   * 设置自定义变量
   */
  async setCustomVariable(name, value, description = '') {
    // 检查是否与系统变量冲突
    if (this.systemVariables.has(name)) {
      throw new Error(`无法覆盖系统变量: ${name}`);
    }

    this.customVariables.set(name, value);
    
    // 异步持久化到数据库
    if (this.db) {
      this.db.saveVariable(name, value, description).catch(err => {
        this.log('warn', `持久化自定义变量 ${name} 失败: ${err.message}`);
      });
    }
  }

  /**
   * 获取变量值 (异步)
   */
  async getVariableValue(name, playerId, depth = 0, contextData = {}) {
    if (depth > 10) {
      this.log('warn', `变量解析超过最大递归深度: ${name}`);
      return '';
    }

    // 1. 检查系统变量
    let sysVar = this.systemVariables.get(name);
    
    if (!sysVar) {
      // 尝试通过别名映射反查原始字段名
      for (const [alias, field] of this.inputAliases) {
        if (name === alias) { // 修正：应该是完全匹配别名
          sysVar = this.systemVariables.get(field);
          if (sysVar) break;
        }
      }
    }

    if (sysVar) {
      // 优先从 contextData 获取显式传递的同名变量，防止系统变量影子逻辑失效
      const directVal = this._getValueByPath(contextData, name);
      if (directVal !== undefined) return directVal;

      if (!playerId) {
        return '';
      }
      if (!this.state.players[playerId] && this.db) {
        try {
          const _lp = await this.db.getPlayer(playerId);
          if (_lp) this.state.players[playerId] = _lp;
        } catch (e) { /* lazy load err */ }
      }
      return await sysVar.getter(playerId, this, contextData);
    }

    // 1.2 检查 contextData (传入 renderTemplate 的 data)
    const directVal = this._getValueByPath(contextData, name);
    if (directVal !== undefined) return directVal;

    // 1.3 特殊处理：尝试作为玩家属性直接获取
    const player = this.state.players[playerId];
    if (player) {
      let attrName = name;
      if (name.startsWith('玩家')) {
        attrName = name.substring(2);
      }
      if (player[attrName] !== undefined) {
        return player[attrName];
      }
      // 尝试别名反查
      const originalAttr = this.inputAliases.get(attrName);
      if (originalAttr && player[originalAttr] !== undefined) {
        return player[originalAttr];
      }
    }

    // 2. 检查自定义变量
    let value = this.customVariables.get(name);
    if (value === undefined) {
      for (const [alias, field] of this.inputAliases) {
        if (name.includes(alias)) {
          const originalName = name.replace(alias, field);
          value = this.customVariables.get(originalName);
          if (value !== undefined) break;
        }
      }
    }

    if (value !== undefined) {
      // 支持 URL 变量
      if (typeof value === 'string' && value.startsWith('url:')) {
        return await this._fetchVariableFromUrl(value.substring(4), playerId);
      }
      return await this._evaluateExpression(value, playerId, depth + 1, contextData);
    }

    return '';
  }

  /**
   * 解析并计算表达式 (异步)
   */
  async _evaluateExpression(value, playerId, depth, contextData = {}) {
    if (typeof value !== 'string') return value;

    // 首先异步替换表达式中的所有 [变量]
    const varRegex = /\[([\u4e00-\u9fa5\w]+)\]/g;
    const varMatches = [...value.matchAll(varRegex)];
    let resolvedExpr = value;

    for (const match of varMatches) {
      // 递归获取变量值，增加 depth 以防死循环
      let val = await this.getVariableValue(match[1], playerId, depth + 1, contextData);
      
      // 如果获取失败（返回了 [变量名] 字符串），则尝试从 contextData 直接获取
      if (typeof val === 'string' && val === match[0]) {
        const directVal = this._getValueByPath(contextData, match[1]);
        if (directVal !== undefined) val = directVal;
      }

      // 处理替换值：数学计算中，无法解析的变量应默认为 0
      let replacement;
      if (typeof val === 'number') {
        replacement = val;
      } else if (val === undefined || val === null || val === '' || (typeof val === 'string' && val.startsWith('['))) {
        // 如果是占位符或空值，在数学表达式中视为 0
        replacement = 0;
      } else {
        // 尝试转换为数字
        const num = Number(val);
        if (!isNaN(num) && String(val).trim() !== '') {
          replacement = num;
        } else {
          // 非数字字符串，包裹引号以供 JS 执行 (虽然数学公式通常不应包含这些)
          replacement = JSON.stringify(String(val));
        }
      }
      // 使用全局替换，确保同一变量在表达式中出现多次时都能被替换
      resolvedExpr = resolvedExpr.split(match[0]).join(String(replacement));
    }

    try {
      const mathContext = {
        round: Math.round,
        floor: Math.floor,
        ceil: Math.ceil,
        max: Math.max,
        min: Math.min,
        abs: Math.abs,
        PI: Math.PI,
        random: Math.random,
        Number: Number,
        String: String,
        engine: this,
        core: this
      };
      
      // 安全检查：不允许包含赋值、分号、或敏感全局变量
      if (/[;=]/.test(resolvedExpr) || /process|require|global|window|eval/i.test(resolvedExpr)) {
        throw new Error('表达式包含非法字符或潜在不安全代码');
      }

      const func = new Function(...Object.keys(mathContext), `try { return ${resolvedExpr}; } catch(e) { return 0; }`);
      const result = func(...Object.values(mathContext));
      
      // 如果结果是 NaN，返回 0 以保证数值链条不断裂
      if (typeof result === 'number' && isNaN(result)) return 0;
      
      return result !== undefined ? result : 0;
    } catch (err) {
      this.log('warn', `解析表达式失败: "${value}" -> "${resolvedExpr}". 错误: ${err.message}`);
      // 计算失败时，如果表达式看起来不像纯数学公式，则返回原始替换后的字符串
      return resolvedExpr;
    }
  }

  /**
   * 加载持久化变量
   */
  async _loadVariablesFromDatabase() {
    if (!this.db) return;
    try {
      const dbVars = await this.db.getAllVariables();
      for (const v of dbVars) {
        const { name, value } = v;
        if (this.systemVariables.has(name)) {
          this.log('warn', `数据库中的自定义变量 ${name} 与系统变量冲突，已跳过。`);
          continue;
        }
        this.customVariables.set(name, value);
      }
      this.log('info', `从数据库加载了 ${dbVars.length} 个自定义变量。`);
    } catch (err) {
      this.log('warn', `从数据库加载变量失败: ${err.message}`);
    }
  }

  /**
   * 注册内置系统变量
   */
  _registerSystemVariables() {
    const playerGetter = (field) => (playerId, core) => {
      const player = core.state.players[playerId];
      if (!player) return '';
      const val = player[field];
      return val !== undefined ? val : '';
    };

    const vars = [
      ['玩家生命', '生命', ['玩家hp']],
      ['玩家生命上限', '生命上限', ['玩家maxhp']],
      ['玩家魔法', '魔法', ['玩家mp']],
      ['玩家魔法上限', '魔法上限', ['玩家maxmp']],
      ['玩家等级', '等级', ['玩家lv']],
      ['玩家经验', '经验', ['玩家exp']],
      ['玩家攻击', '攻击', ['玩家atk']],
      ['玩家防御', '防御', ['玩家def']],
      ['玩家暴击率', '暴击率', ['玩家crit']],
      ['玩家暴击伤害', '暴击伤害', ['玩家critdmg', '玩家爆伤']],
      ['玩家闪避率', '闪避率', ['玩家dodge']],
      ['玩家金币', '货币1', ['玩家货币1']],
      ['玩家银币', '货币2', ['玩家货币2']],
      ['玩家铜币', '货币3', ['玩家货币3']],
      ['玩家特殊货币', '特殊货币', []],
      ['玩家职业途径', '职业途径', []],
      ['玩家职业序列', '职业序列', []],
      ['玩家初始地图', '初始地图', []],
      ['玩家ID', 'id', ['playerId']],
      ['玩家昵称', '昵称', []],
      ['玩家性别', '性别', []],
    ];

    vars.forEach(([name, field, aliases]) => {
      this.registerSystemVariable(name, playerGetter(field), aliases);
    });

    // 特殊处理：玩家位置
    this.registerSystemVariable('玩家位置', (playerId, core) => {
      const player = core.state.players[playerId];
      if (!player) return '';
      return player.当前地图 || player.初始地图 || '';
    }, ['玩家地图']);

    // 地图相关变量
    const mapGetter = (field) => (playerId, core) => {
      const player = core.state.players[playerId];
      if (!player) return '';
      const mapName = player.当前地图 || player.初始地图;
      const map = core.state.world.maps?.[mapName];
      if (!map) return '';
      
      if (field === 'connections') {
        const conns = [];
        if (map.connections?.up) conns.push(`上=${map.connections.up}`);
        if (map.connections?.down) conns.push(`下=${map.connections.down}`);
        if (map.connections?.left) conns.push(`左=${map.connections.left}`);
        if (map.connections?.right) conns.push(`右=${map.connections.right}`);
        return conns.length > 0 ? conns.join('\n') : '';
      }
      
      const val = map[field];
      if (Array.isArray(val)) {
        const filtered = val.filter(v => v && v.trim() !== '');
        return filtered.length > 0 ? filtered.join(' | ') : '';
      }
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('地图名', mapGetter('name'));
    this.registerSystemVariable('地图简介', mapGetter('description'));
    this.registerSystemVariable('地图怪物', mapGetter('monsters'));
    this.registerSystemVariable('地图NPC', mapGetter('npcs'));
    this.registerSystemVariable('地图掉落物', mapGetter('items'), ['地图物品']);
    this.registerSystemVariable('地图连接方向数据', mapGetter('connections'));
    this.registerSystemVariable('地图物品列表', mapGetter('items'));
    this.registerSystemVariable('地图怪物列表', mapGetter('monsters'));
    this.registerSystemVariable('地图NPC列表', mapGetter('npcs'));

    // 怪物相关变量 (支持上下文或当前战斗目标)
    const monsterGetter = (field) => (playerId, core, contextData) => {
      // 1. 优先从 contextData 直接获取显式传递的变量
      if (contextData) {
        // 映射字段名到 contextData 中的键
        const fieldToKey = {
          'name': '怪物名',
          'currentHp': '怪物生命',
          '生命上限': '怪物生命上限',
          '魔法上限': '怪物魔法上限'
        };
        const key = fieldToKey[field] || field;
        const directVal = contextData[key] || contextData[field];
        if (directVal !== undefined && directVal !== '') return directVal;
      }

      let monster = null;
      // 2. 尝试从上下文获取对象
      if (contextData) {
        monster = contextData.monster || contextData.monsterInstance || (contextData.name && contextData.stats ? contextData : null);
      }
      
      // 3. 其次从当前战斗状态获取
      if (!monster && playerId && core.state.combat?.[playerId]) {
        const combat = core.state.combat[playerId];
        monster = core.state.monsterInstances?.[combat.lockedMonsterId];
      }
      
      if (!monster) {
        // 4. 最后兜底：尝试从 contextData 寻找可能存在的怪物名称字符串
        return contextData?.怪物名 || contextData?.monsterName || contextData?.monster_name || '';
      }
      
      // 如果找到了 monster 对象，提取属性
      const defName = monster.definitionName || monster.name || contextData?.怪物名;
      const def = core.state.monsters?.[defName];
      const data = { ...def, ...monster }; // 实例属性覆盖定义属性

      if (field === 'currentHp') return monster.currentHp !== undefined ? monster.currentHp : (data.stats?.生命 || 0);
      if (field === 'name') return data.name || monster.name || defName || '';
      
      // 处理生命上限与魔法上限
      if (field === '生命上限') return monster.max生命 || (data.stats?.生命 || (def?.stats?.生命 || ''));
      if (field === '魔法上限') return monster.max魔法 || (data.stats?.魔法 || (def?.stats?.魔法 || ''));
      
      if (field === 'drops') {
        return (data.drops || []).map(d => `${d.name} (几率:${d.chance})`).join('\n');
      }
      if (field === 'skills') {
        return (data.skills || []).map(s => s.name).join('\n');
      }
      
      // 检查是否在 stats 中
      if (data.stats && data.stats[field] !== undefined) return data.stats[field];
      
      const val = data[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('怪物名', monsterGetter('name'));
    this.registerSystemVariable('怪物分类', monsterGetter('category'));
    this.registerSystemVariable('怪物介绍', monsterGetter('description'));
    this.registerSystemVariable('怪物等级', monsterGetter('level'));
    this.registerSystemVariable('怪物经验奖励', monsterGetter('expReward'));
    this.registerSystemVariable('怪物重生时间', monsterGetter('respawnTime'));
    this.registerSystemVariable('怪物生命', monsterGetter('currentHp'), ['怪物血量']);
    this.registerSystemVariable('怪物生命上限', monsterGetter('生命上限'), ['怪物体力上限', '怪物maxhp']);
    this.registerSystemVariable('怪物防御', monsterGetter('防御'));
    this.registerSystemVariable('怪物攻击', monsterGetter('攻击'));
    this.registerSystemVariable('怪物魔法', monsterGetter('魔法'));
    this.registerSystemVariable('怪物魔法上限', monsterGetter('魔法上限'), ['怪物maxmp']);
    this.registerSystemVariable('怪物暴击率', monsterGetter('暴击率'));
    this.registerSystemVariable('怪物暴击伤害', monsterGetter('暴击伤害'), ['怪物爆伤']);
    this.registerSystemVariable('怪物闪避率', monsterGetter('闪避率'));
    this.registerSystemVariable('怪物技能', monsterGetter('skills'));
    this.registerSystemVariable('怪物掉落物', monsterGetter('drops'));

    // 战斗相关变量
    this.registerSystemVariable('当前回合', (playerId, core) => {
      const combat = core.state.combat?.[playerId];
      return combat ? combat.turn : '';
    });

    // 背包相关变量
    this.registerSystemVariable('背包全部数据', (playerId, core) => {
      const player = core.state.players[playerId];
      if (!player || !player.背包) return '背包空空如也。';
      
      const lines = Object.entries(player.背包)
        .filter(([name]) => name && name.trim() !== '') // 过滤掉空名称的物品
        .map(([name, count]) => `${name} x${count}`);
        
      return lines.length > 0 ? lines.join('\n') : '背包空空如也。';
    });

    this.registerSystemVariable('背包筛选数据', (playerId, core, contextData) => {
      const items = contextData.filteredItems || [];
      const lines = items
        .filter(item => item.name && item.name.trim() !== '') // 过滤掉空名称的物品
        .map(item => `${item.name} x${item.count}`);
        
      return lines.length > 0 ? lines.join('\n') : '没有找到匹配的物品。';
    });

    // 物品/装备相关变量
    const itemGetter = (field) => (playerId, core, contextData) => {
      const item = contextData.item || contextData;
      if (!item || !item.name) return '';
      
      const def = core.state.items?.[item.name] || core.state.equipmentDefinitions?.[item.name] || item;
      
      if (field === 'slot_name') {
        const slotId = def.slot_id || def.slotId;
        if (!slotId) return '无';
        const slot = core.equipment?.getSlot(slotId);
        return slot ? slot.name : slotId;
      }

      if (field === 'stats_str') {
        return Object.entries(def.stats || {}).map(([k, v]) => `${k}+${v}`).join(', ');
      }
      if (field === 'unsealMaterials') {
        return (def.unsealMaterials || []).map(m => `${m.itemName} x${m.quantity}`).join(', ');
      }
      
      // 检查是否在 stats 中
      if (def.stats && def.stats[field] !== undefined) return def.stats[field];
      
      const val = def[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('物品名', itemGetter('name'), ['装备名']);
    this.registerSystemVariable('物品分类', itemGetter('category'));
    this.registerSystemVariable('物品介绍', itemGetter('description'), ['装备介绍']);
    this.registerSystemVariable('装备所属部位', itemGetter('slot_name'));
    this.registerSystemVariable('装备等级限制', itemGetter('level_required'));
    this.registerSystemVariable('装备职业途径限制', itemGetter('class_required'));
    this.registerSystemVariable('装备提供基础属性', itemGetter('stats_str'));
    this.registerSystemVariable('装备附带技能', itemGetter('skill'));
    this.registerSystemVariable('装备封印状态', (playerId, core, contextData) => {
      const item = contextData.item || contextData;
      return (item && item.sealed) ? '已封印' : '未封印';
    });
    this.registerSystemVariable('装备解封材料', itemGetter('unsealMaterials'));
    this.registerSystemVariable('装备所属套装', itemGetter('setEffect'));

    // 套装相关变量
    const setGetter = (field) => (playerId, core, contextData) => {
      const setName = contextData.setName || contextData.name;
      if (!setName) return '';
      const setDef = core.state.setDefinitions?.[setName] || contextData;
      
      if (field === 'components') {
        return (setDef.components || setDef.items || []).join(', ');
      }
      if (field === 'effects') {
        // 格式化套装效果层级
        const tiers = setDef.effects?.tiers || [];
        return tiers.map(t => `${t.requiredCount}件套：${(t.effects || []).map(e => `${e.attr || e.type}+${e.value}`).join(', ')}`).join('\n');
      }
      
      const val = setDef[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('套装名', setGetter('name'));
    this.registerSystemVariable('套装描述', setGetter('description'));
    this.registerSystemVariable('套装组件', setGetter('components'));
    this.registerSystemVariable('套装效果', setGetter('effects'));

    // 商店相关变量
    const shopGetter = (field) => (playerId, core, contextData) => {
      const shop = contextData.shop || contextData;
      if (!shop || !shop.name) return '';
      
      const def = core.state.shops?.[shop.name] || shop;
      
      if (field === 'items') {
        return (def.items || []).map(i => `${i.item_name} - 价格:${i.price} (${i.currency_type})`).join('\n');
      }
      
      const val = def[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('商店名', shopGetter('name'));
    this.registerSystemVariable('商店介绍', shopGetter('description'));
    this.registerSystemVariable('商品列表数据', shopGetter('items'));
    this.registerSystemVariable('商店折扣', shopGetter('discount_value'));
    this.registerSystemVariable('折扣持续时间', shopGetter('discount_duration'));
    this.registerSystemVariable('商品名', (playerId, core, context) => context.商品名 || '');
    this.registerSystemVariable('商品价格', (playerId, core, context) => context.商品价格 || '');
    this.registerSystemVariable('商品库存', (playerId, core, context) => context.商品库存 || '');
    this.registerSystemVariable('购买数量', (playerId, core, context) => context.购买数量 || '');
    this.registerSystemVariable('出售价格', (playerId, core, context) => context.出售价格 || '');
    this.registerSystemVariable('货币类型', (playerId, core, context) => context.货币类型 || '');

    // NPC 相关变量
    const npcGetter = (field) => (playerId, core, contextData) => {
      const npc = contextData.npc || contextData;
      if (!npc || !npc.name) return '';
      
      const def = core.state.npcs?.[npc.name] || npc;
      
      if (field === 'functions') {
        const funcMap = { dialogue: '对话', shop: '商店', task: '任务', exchange: '兑换' };
        return (def.functions || []).map(f => funcMap[f] || f).join(', ');
      }
      
      const val = def[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('NPC名', npcGetter('name'));
    this.registerSystemVariable('NPC介绍', npcGetter('description'));
    this.registerSystemVariable('NPC功能列表', npcGetter('functions'));
    this.registerSystemVariable('兑换目标货币', (playerId, core, context) => context.兑换目标货币 || '');
    this.registerSystemVariable('兑换数量', (playerId, core, context) => context.兑换数量 || '');

    // 任务相关变量
    const questGetter = (field) => (playerId, core, contextData) => {
      const quest = contextData.quest || contextData;
      if (!quest || !quest.name) return '';
      
      const def = core.state.quests?.[quest.name] || quest;
      
      if (field === 'rewards') {
        try {
          const rewards = typeof def.rewards === 'string' ? JSON.parse(def.rewards) : def.rewards;
          return (rewards || []).map(r => {
            if (r.type === 'exp') return `经验 x${r.value}`;
            if (r.type === 'currency') return `${core.getAlias('货币' + r.value)} x${r.amount}`;
            if (r.type === 'item') return `${r.value} x${r.amount}`;
            return `${r.type} x${r.value || r.amount}`;
          }).join(', ');
        } catch (e) { return ''; }
      }
      
      if (field === 'conditions') {
        try {
          const conditions = typeof def.conditions === 'string' ? JSON.parse(def.conditions) : def.conditions;
          return (conditions || []).map(c => {
            if (c.type === 'level') return `等级 >= ${c.value}`;
            if (c.type === 'quest_completed') return `完成任务: ${c.value}`;
            return `${c.type}: ${c.value}`;
          }).join(', ');
        } catch (e) { return ''; }
      }
      
      const val = def[field];
      return val !== undefined ? val : '';
    };

    this.registerSystemVariable('任务名', questGetter('name'));
    this.registerSystemVariable('任务介绍', questGetter('description'));
    this.registerSystemVariable('任务奖励', questGetter('rewards'));
    this.registerSystemVariable('任务条件', questGetter('conditions'));
    this.registerSystemVariable('任务类型', questGetter('type'));
    
    this.registerSystemVariable('任务列表', (playerId, core, context) => context.任务列表 || '');
  }

  /**
   * 获取所有可用变量名
   */
  getAllVariableNames() {
    const names = new Set(this.systemVariables.keys());
    for (const name of this.customVariables.keys()) {
      names.add(name);
    }
    return Array.from(names);
  }

  /**
   * 获取字段的显示别名
   */
  getAlias(field) {
    return this.attributeAliases.get(field) || field;
  }

  /**
   * 获取所有别名映射
   */
  getAllAliases() {
    return Object.fromEntries(this.attributeAliases);
  }

  /**
   * 手动设置数据库连接
   */
  setDatabase(connection) {
    this.db = connection;
    this.log('info', '数据库连接已建立。');
  }
}

module.exports = GameSystem;