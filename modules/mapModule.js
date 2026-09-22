/**
 * 地图与移动系统模块 - 处理地图查看、四方向移动及掉落物拾取
 */
async function mapModule(core) {
  core.log('info', '正在加载地图与移动系统模块...');

  // 1. 检查依赖
  if (!core.db) {
    throw new Error('地图模块加载失败：数据库模块未就绪。');
  }
  if (!core.getModule('player')) {
    core.log('warn', '玩家模块未加载，地图功能可能受限。');
  }

  // 2. 初始化地图数据
  const { worldSeed } = require('./world/load.js');

  const defaultMaps = {
    '新手村': {
      name: '新手村',
      description: '宁静的村庄，冒险者的起点',
      monsters: [],
      npcs: ['村长'],
      items: ['初级药水', '测试礼包'],
      connections: { right: '新手郊外' },
      x: 0,
      y: 0
    },
    '新手郊外': {
      name: '新手郊外',
      description: '村庄外的草地，偶尔有小型怪物出没。',
      monsters: ['史莱姆', '野兔'],
      npcs: [],
      items: ['木剑'],
      connections: { left: '新手村', up: '森林' },
      x: 1,
      y: 0
    },
    '森林': {
      name: '森林',
      description: '茂密的森林，充满危险。',
      monsters: ['野狼', '森林熊', '森林狼王'],
      npcs: [],
      items: ['木材'],
      connections: { down: '新手郊外' },
      x: 1,
      y: -1
    }
  };

  // 数据库持久化初始化：如果数据库中没有地图，则写入默认地图
  // ── 世界种子合并（2026-09-19）──────────────────────────────────────────────
  // modules/world/maps.json 是从当前正式世界（data/game.db）导出的内容种子，是唯一真源；
  // 内置的两张地图只在种子文件缺失/为空时兜底。已有库完全不受影响。
  const worldMaps = worldSeed('maps', Object.values(defaultMaps));
  const seedMaps = Object.fromEntries(worldMaps.map((m) => [m.name, m]));
  const dbMaps = await core.db.getAllMaps();
  if (dbMaps.length === 0) {
    core.log('info', `数据库地图表为空，正在写入世界种子地图数据（${worldMaps.length} 张）...`);
    for (const [name, data] of Object.entries(seedMaps)) {
      await core.db.saveMap(name, data);
    }
  }

  // 如果状态中没有地图数据，则从数据库加载或初始化为默认数据
  if (!core.state.world.maps || Object.keys(core.state.world.maps).length === 0) {
    const maps = await core.db.getAllMaps();
    const mapObj = {};
    if (maps.length > 0) {
      maps.forEach(m => mapObj[m.name] = m);
      core.updateState('world.maps', mapObj);
      core.log('info', `从数据库加载了 ${maps.length} 个地图。`);
    } else {
      core.updateState('world.maps', seedMaps);
      core.log('info', '地图数据已初始化为默认配置。');
    }
  }

  // 3. 辅助方法实现
  const helpers = {
    /**
     * 获取指定名称的地图对象
     */
    getMap: (mapName) => {
      return core.state.world.maps[mapName] || null;
    },

    /**
     * 获取玩家当前所在的地图对象
     */
    getPlayerMap: (playerId) => {
      const player = core.state.players[playerId];
      if (!player) return null;
      const mapName = player.当前地图 || player.初始地图;
      return helpers.getMap(mapName);
    },

    /**
     * 获取所有地图名称列表
     */
    getAllMaps: () => {
      return Object.keys(core.state.world.maps);
    },

    /**
     * 从地图移除怪物
     */
    removeMonsterFromMap: async (mapName, monsterName) => {
      const map = core.state.world.maps[mapName];
      if (!map) return false;
      const index = map.monsters.indexOf(monsterName);
      if (index === -1) return false;
      map.monsters.splice(index, 1);
      
      // 更新内存状态
      core.updateState(`world.maps.${mapName}.monsters`, [...map.monsters]);
      
      // 持久化到数据库 (关键修复：确保重启后生效)
      if (core.db) {
        await core.db.saveMap(mapName, map);
      }
      return true;
    },

    /**
     * 向地图添加怪物
     */
    addMonsterToMap: async (mapName, monsterName) => {
      const map = core.state.world.maps[mapName];
      if (!map) return false;
      map.monsters.push(monsterName);
      
      // 更新内存状态
      core.updateState(`world.maps.${mapName}.monsters`, [...map.monsters]);
      
      // 持久化到数据库 (关键修复：确保重启后生效)
      if (core.db) {
        await core.db.saveMap(mapName, map);
      }
      return true;
    },

    /**
     * 保存地图并自动连接相邻地图
     */
    saveMap: async (name, data) => {
      const db = core.db;
      const x = parseInt(data.x);
      const y = parseInt(data.y);
      
      try {
        // 开启事务确保数据一致性
        await db.run('BEGIN TRANSACTION');

        // 1. 获取所有现有地图以查找邻居
        const allMaps = await db.getAllMaps();
        
        // 定义方向映射 (与编辑器前端和移动指令保持一致)
        const directions = [
          { key: 'up',    dx: 0,  dy: -1, opp: 'down' },
          { key: 'down',  dx: 0,  dy: 1,  opp: 'up'   },
          { key: 'left',  dx: -1, dy: 0,  opp: 'right' },
          { key: 'right', dx: 1,  dy: 0,  opp: 'left'  }
        ];

        // 确保 connections 是对象
        if (!data.connections || typeof data.connections !== 'object') {
          data.connections = {};
        }

        // 自动建立双向连接逻辑
        for (const dir of directions) {
          const nx = x + dir.dx;
          const ny = y + dir.dy;
          
          // 查找该位置是否已有地图
          const neighbor = allMaps.find(m => Number(m.x) === nx && Number(m.y) === ny && m.name !== name);
          if (neighbor) {
            // 1. 新地图 -> 邻居 (如果该方向未设置或为空)
            const currentConn = data.connections[dir.key];
            if (!currentConn || currentConn === '' || currentConn === '无') {
              data.connections[dir.key] = neighbor.name;
            }
            
            // 2. 邻居 -> 新地图 (如果邻居的反方向未设置或为空)
            if (!neighbor.connections) neighbor.connections = {};
            const neighborConn = neighbor.connections[dir.opp];
            if (!neighborConn || neighborConn === '' || neighborConn === '无') {
              neighbor.connections[dir.opp] = name;
              // 保存邻居的更新到数据库
              await db.saveMap(neighbor.name, neighbor);
              // 同步更新邻居内存状态
              core.updateState(`world.maps.${neighbor.name}`, { ...neighbor });
            }
          }
        }

        // 2. 保存当前地图到数据库
        await db.saveMap(name, data);
        
        // 提交事务
        await db.run('COMMIT');

        // 3. 更新内存中的状态 (仅更新当前受影响的地图)
        core.updateState(`world.maps.${name}`, { ...data });
        
        return true;
      } catch (err) {
        // 出错时回滚
        await db.run('ROLLBACK');
        throw err;
      }
    }
  };


  const commands = [
    { logical_name: 'map:view', default_triggers: ['查看地图', '地图'], description: '查看当前所在地图的信息' },
    { logical_name: 'map:move', default_triggers: ['移动', '去'], description: '在地图间移动 (支持方向: 上下左右 或 地图名)' },
    { logical_name: 'map:pickup', default_triggers: ['拾取', '捡'], description: '拾取当前地图上的道具' }
  ];

  const templates = {
    'map.view': {
      text: `【[地图名]】\n[地图简介]\n--- 存在 ---\n[地图怪物列表]\n[地图NPC列表]\n[地图物品列表]\n--- 出口 ---\n[地图连接方向数据]`,
      markdown: `【**[地图名]**】\n[地图简介]\n--- 存在 ---\n[地图怪物列表]\n[地图NPC列表]\n[地图物品列表]\n--- 出口 ---\n[地图连接方向数据]`
    },
    'map.move.fail': { text: '你无法前往那里。', markdown: '你无法前往那里。' },
    'map.move.success': { text: '你移动到了 [地图名]。', markdown: '你移动到了 **[地图名]**。' },
    'map.pickup.fail': { text: '这里没有 {itemName}。', markdown: '这里没有 **{itemName}**。' },
    'map.move.success_view': { text: '{移动提示|raw}\n\n{地图信息|raw}', markdown: '{移动提示|raw}\n\n{地图信息|raw}' },
    'map.pickup.success': { text: '你拾取了 {itemName}。', markdown: '你拾取了 **{itemName}**。' },
    'map:view.success': {
      text: `【[地图名]】\n[地图简介]\n--- 存在 ---\n[地图怪物列表]\n[地图NPC列表]\n[地图物品列表]\n--- 出口 ---\n[地图连接方向数据]`,
      markdown: `【**[地图名]**】\n[地图简介]\n--- 存在 ---\n[地图怪物列表]\n[地图NPC列表]\n[地图物品列表]\n--- 出口 ---\n[地图连接方向数据]`
    }
  };

  const handlers = {
    'map:view': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await core.requirePlayer(playerId);
        if (player.error) return player;

      const map = helpers.getPlayerMap(playerId);
      if (!map) return { status: 'fail', data: {}, templateKey: 'system.error' };
      return { status: 'success', data: { ...map }, templateKey: 'map:view' };
    },

    'map:move': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await core.requirePlayer(playerId);
        if (player.error) return player;

      const target = args[0];
      if (!target) return { status: 'fail', data: {}, templateKey: 'system.invalid_command_args' };

      const currentMap = helpers.getPlayerMap(playerId);
      if (!currentMap) return { status: 'fail', data: {}, templateKey: 'system.error' };

      let targetMapName = null;
      const directionMap = { '上': 'up', '下': 'down', '左': 'left', '右': 'right' };
      const dirKey = directionMap[target];

      if (dirKey) {
        targetMapName = currentMap.connections?.[dirKey];
      } else {
        const isConnected = Object.values(currentMap.connections || {}).includes(target);
        if (isConnected) targetMapName = target;
      }

      // 严格校验目标地图是否存在
      if (!targetMapName || targetMapName === '无' || targetMapName === '' || !core.state.world.maps[targetMapName]) {
        const failTemplate = await core.db.getMessageTemplate('map', 'move.fail') || templates['map.move.fail'].markdown;
        return await core.renderTemplate(failTemplate, { target }, { escape: true }, playerId);
      }

      const fromMap = currentMap.name;
      const toMap = targetMapName;

      try {
        player.当前地图 = toMap;
        await core.services.player.modify({
          playerId,
          changes: { 当前地图: { set: toMap } },
          source: 'map:move'
        });
        core.updateState(`players.${playerId}.当前地图`, toMap);

        await core.emit('player:moved', playerId, fromMap, toMap);
        core.log('info', `玩家 ${playerId} 从 ${fromMap} 移动到了 ${toMap}`);

        const successTemplate = await core.db.getMessageTemplate('map', 'move.success') || templates['map.move.success'].markdown;
        const msg = await core.renderTemplate(successTemplate, { from: fromMap, to: toMap }, { escape: true }, playerId);
        
        const viewRes = await handlers['map:view']({ playerId, args: [], core, services });
        const viewTpl = await core.db.getMessageTemplate('map', 'view') || templates['map.view'].markdown;
        const viewContent = await core.renderTemplate(viewTpl, viewRes.data || {}, { escape: false }, playerId);
        return { status: 'success', data: { 移动提示: msg, 地图信息: viewContent }, templateKey: 'map:move.success_view' };
      } catch (err) {
        core.log('error', `玩家移动失败: ${err.message}`);
        throw err;
      }
    },

    'map:pickup': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await core.requirePlayer(playerId);
        if (player.error) return player;

      const itemName = args[0];
      if (!itemName) return { status: 'fail', data: {}, templateKey: 'system.invalid_command_args' };

      const map = helpers.getPlayerMap(playerId);
      if (!map || !map.items) return { status: 'fail', data: {}, templateKey: 'map.pickup.fail' };

      const itemIndex = map.items.indexOf(itemName);
      if (itemIndex === -1) {
        // DB-FIRST：返回协议对象让 core 渲染
        return { status: 'fail', data: { itemName }, templateKey: 'map:pickup.fail' };
      }

      const newItems = [...map.items];
      newItems.splice(itemIndex, 1);

      try {
        // 1. 先更新内存状态 (同步操作)，防止竞态条件下重复拾取
        map.items = newItems;
        core.updateState(`world.maps.${map.name}.items`, newItems);

        // 2. 然后再持久化到数据库
        await core.db.saveMap(map.name, { ...map, items: newItems });
        
        await core.emit('item:picked_up', playerId, itemName, map.name);
        core.log('info', `玩家 ${playerId} 在 ${map.name} 拾取了 ${itemName}`);

        // DB-FIRST：返回协议对象让 core 渲染
        return { status: 'success', data: { itemName }, templateKey: 'map:pickup.success' };
      } catch (err) {
        core.log('error', `拾取物品失败 (持久化错误): ${err.message}`);
        // 如果持久化失败，理论上应该回滚内存，但简单起见此处提示错误
        return { status: 'fail', data: {}, templateKey: 'system.error' };
      }
    }
  };

  core.registerModule('map', { doors: commands, templates, handlers });

  core.registerDataSource('地图', {
    description: '地图定义表',
    fields: ['名称','简介','怪物','NPC','物品','连接','X','Y'],
    resolve: async (对象, 字段, ctx) => {
      if (!对象) return undefined;
      let targetName = 对象;
      if (对象 === '当前') {
        const p = ctx.playerId ? await ctx.core._playerService.get(ctx.playerId) : null;
        targetName = p ? (p.当前地图 || p.初始地图) : null;
      }
      if (!targetName) return undefined;
      const row = await ctx.core.db.get('SELECT * FROM maps WHERE name=?', [targetName]);
      if (!row) return undefined;
      // 2026-09-19：地图的 X / Y（坐标）已废弃，不再对外暴露（详见报告：核心 saveMap 仍会写这两列，属禁改文件）
      const map = { '名称':'name','简介':'description','描述':'description','怪物':'monsters','NPC':'npcs','物品':'items','连接':'connections' };
      return row[map[字段]] !== undefined ? row[map[字段]] : row[字段];
    }
  });

  core.log('info', '地图与移动系统模块加载成功。');

  return {
    moduleName: 'map',
    ...helpers
  };
}

mapModule.moduleName = 'map';
mapModule.dependencies = ['database', 'player'];

module.exports = mapModule;
