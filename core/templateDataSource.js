/**
 * 模板数据源机制 - 支持 {命名空间.对象.字段} 语法
 *
 * 内置数据源（此文件注册）：系统、参数
 * 各模块注册：玩家(playerModule)、物品(itemModule)、怪物(combatModule)、
 *           地图(mapModule)、NPC(npcModule)、任务(questModule)、
 *           技能(skillModule)、职业(professionModule)
 * 用户自定义：存 editor_settings.custom_data_sources
 */
module.exports = function registerDataSourceSystem(core) {
  // 存所有注册的数据源
  core._dataSources = new Map();

  // 注册接口
  core.registerDataSource = (name, def) => {
    if (!name || typeof name !== 'string' || !def) return;
    core._dataSources.set(name, {
      description: def.description || '',
      fields: def.fields || [],
      custom: !!def.custom,
      resolve: def.resolve
    });
  };

  // 求值接口
  core.resolveDataSource = async (name, 对象, 字段, ctx) => {
    const ds = core._dataSources.get(name);
    if (!ds || typeof ds.resolve !== 'function') return undefined;
    try {
      return await ds.resolve(对象, 字段, ctx);
    } catch (e) {
      core.log('warn', `[dataSource:${name}] 解析失败 (对象=${对象}, 字段=${字段}): ${e.message}`);
      return undefined;
    }
  };

  // 列出所有数据源（编辑器用）
  core.listDataSources = () => {
    return Array.from(core._dataSources.entries()).map(([name, def]) => ({
      name,
      description: def.description,
      fields: def.fields,
      builtin: !def.custom
    }));
  };

  // 从 editor_settings 加载用户自定义数据源
  core.loadCustomDataSources = async () => {
    if (!core.db || typeof core.db.get !== 'function') return;
    let raw;
    try {
      raw = await core.db.get("SELECT value FROM editor_settings WHERE key='custom_data_sources'");
    } catch (e) {
      core.log('warn', '读取自定义数据源失败: ' + e.message);
      return;
    }
    if (!raw || !raw.value) return;
    try {
      const arr = JSON.parse(raw.value);
      if (!Array.isArray(arr)) return;
      for (const ds of arr) {
        if (!ds.name || !ds.table || !ds.primaryKey) continue;
        core.registerDataSource(ds.name, {
          description: ds.description || '自定义数据源',
          fields: ds.fields || [],
          custom: true,
          resolve: async (对象, 字段, ctx) => {
            const row = await ctx.core.db.get(
              `SELECT * FROM ${ds.table} WHERE ${ds.primaryKey} = ?`, [对象]
            );
            if (!row) return undefined;
            return row[字段];
          }
        });
      }
      core.log('info', `已加载 ${arr.length} 个自定义数据源`);
    } catch (e) { core.log('warn', '自定义数据源加载失败: ' + e.message); }
  };

  // ============ 内置数据源 ============

  // 系统
  core.registerDataSource('系统', {
    description: '游戏全局设置',
    fields: ['游戏名','货币1名','货币2名','货币3名','特殊货币名','初始地图'],
    resolve: async (_, 字段, ctx) => {
      const s = ctx.core.state.settings || {};
      const map = { '游戏名':'game_name', '货币1名':'currency_1_name', '货币2名':'currency_2_name', '货币3名':'currency_3_name', '特殊货币名':'special_currency_name', '初始地图':'initial_map' };
      return s[map[字段]] ?? s[字段];
    }
  });

  // 参数
  core.registerDataSource('参数', {
    description: '当前命令参数',
    fields: ['1','2','3','4','5'],
    resolve: async (_, 字段, ctx) => {
      const args = ctx.data && ctx.data.参数;
      return args && args[Number(字段)-1];
    }
  });
};
