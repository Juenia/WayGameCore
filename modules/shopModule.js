/**
 * 商店系统模块 - 处理商品买卖、折扣与库存管理
 */
async function shopModule(core) {
  core.log('info', '正在加载商店系统模块...');

  // 内部辅助函数
  
  async function checkShopRefresh(shop, services) {
    if (!shop.refresh_interval || shop.refresh_interval <= 0) return;
    
    const now = new Date();
    const lastRefresh = new Date(shop.last_refresh_time || 0);
    const diffMinutes = (now - lastRefresh.getTime()) / (1000 * 60);
    
    if (diffMinutes >= shop.refresh_interval) {
      core.log('info', `商店 ${shop.name} 到达刷新间隔，正在重置库存...`);
      
      shop.last_refresh_time = now.toISOString();
      
      if (shop.items && Array.isArray(shop.items)) {
        shop.items.forEach(item => {
          if (item.base_stock !== undefined && item.base_stock !== null) {
            item.stock = item.base_stock;
          }
        });
      }

      shop.discount_enabled = 0;
      shop.discount_start_time = null;
      
      await core.db.saveShop(shop.name, shop);
      core.updateState(`shops.${shop.name}`, shop);
    }
  }

  function checkDiscountExpired(shop) {
    if (!shop.discount_enabled || !shop.discount_duration || shop.discount_duration <= 0) return false;
    if (!shop.discount_start_time) return false;

    const now = new Date();
    const startTime = new Date(shop.discount_start_time);
    const diffMinutes = (now.getTime() - startTime.getTime()) / (1000 * 60);
    
    if (diffMinutes >= shop.discount_duration) {
      shop.discount_enabled = 0;
      core.db.saveShop(shop.name, shop);
      core.updateState(`shops.${shop.name}`, shop);
      return true;
    }
    return false;
  }

  core.registerModule('shop', {
    doors: [
      { logical_name: 'shop:buy', default_triggers: ['购买'], description: '购买指定商品' },
      { logical_name: 'shop:sell', default_triggers: ['出售'], description: '出售指定商品' },
      { logical_name: 'shop:list', default_triggers: ['商店', '商店列表'], description: '查看当前商店商品列表' }
    ],
    templates: {
      'shop:buy.fail_notfound': { text: '❌ 未找到商品 [商品名]。', markdown: '❌ 未找到商品 **[商品名]**。' },
      'shop:buy.fail_stock': { text: '❌ 商品 [商品名] 库存不足。', markdown: '❌ 商品 **[商品名]** 库存不足。' },
      'shop:buy.fail_currency': { text: '❌ 你的 [货币类型] 不足。', markdown: '❌ 你的 **[货币类型]** 不足。' },
      'shop:buy.success': { text: '你成功购买了 [购买数量] 个 [商品名]，花费 [商品价格] [货币类型]。', markdown: '你成功购买了 **[购买数量]** 个 **[商品名]**，花费 **[商品价格]** **[货币类型]**。' },
      'shop:sell.fail_nobackpack': { text: '❌ 你的背包中没有 [商品名]。', markdown: '❌ 你的背包中没有 **[商品名]**。' },
      'shop:sell.fail_notfound': { text: '❌ 商店不收购 [商品名]。', markdown: '❌ 商店不收购 **[商品名]**。' },
      'shop:sell.success': { text: '你成功出售了 [商品名]，获得 [出售价格] [货币类型]。', markdown: '你成功出售了 **[商品名]**，获得 **[出售价格]** **[货币类型]**。' },
      'shop:list.success': { text: '📜 【[商店名]】\n[商店介绍]\n[商品列表数据]\n[if:商店折扣]折扣: [商店折扣]% (剩余 [折扣持续时间] 分钟)[/if]', markdown: '📜 【**[商店名]**】\n[商店介绍]\n[商品列表数据]\n[if:商店折扣]折扣: [商店折扣]% (剩余 [折扣持续时间] 分钟)[/if]' },
      'shop:list.fail_notfound': { text: '商店 [商店名] 不存在。', markdown: '商店 **[商店名]** 不存在。' }
    },
    handlers: {
      'shop:buy': async (request) => {
        const { playerId, args, services } = request;
        const itemName = args[0];
        const amount = parseInt(args[1]) || 1;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };

        if (!itemName) {
          return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };
        }

        // 查找当前地图可用的商店
        const currentMapName = player.当前地图 || player.初始地图;
        const allShops = await services.query.list('shops');
        
        const availableShops = allShops.filter(shop => {
          if (!shop.npc_name) return true;
          // 商店有指定 NPC 时，检查 NPC 是否在当前地图
          const npc = core.state.npcs?.[shop.npc_name];
          if (!npc) return true;  // NPC 数据未加载时不过滤，避免误杀
          return npc.map_name === currentMapName;
        });
        core.log('debug', `[shop:buy] 当前地图=${currentMapName}, 所有商店=${allShops.length}, 可用商店=${availableShops.length}, 查找商品=${itemName}`);

        let targetShop = null;
        let targetItem = null;

        for (const shop of availableShops) {
          await checkShopRefresh(shop, services); // Pass services
          
          let shopItems = shop.items;
          if (typeof shopItems === 'string') {
            try { shopItems = JSON.parse(shopItems); } catch { shopItems = []; }
          }
          if (!Array.isArray(shopItems)) shopItems = [];


          core.log('debug', `[shop:buy] 查找条件: i.item_name === "${itemName}"`);
          const item = shopItems.find(i => i.item_name === itemName);
          core.log('debug', `[shop:buy] 商店=${shop.name}, 商品数=${shopItems.length}, 命中=${!!item}, itemName="${itemName}", 第一个商品的字段=${JSON.stringify(shopItems[0])}`);

          if (item) {
            targetShop = shop;
            targetItem = item;
            break;
          }
        }

        core.log('debug', `[shop:buy] Loop finished. targetShop=${!!targetShop}, targetItem=${!!targetItem}`);

        core.log('debug', `[shop:buy] Returning fail_notfound. targetShop=${!!targetShop}, targetItem=${!!targetItem}`);
        if (!targetShop || !targetItem) {
          return { status: 'fail_notfound', data: { itemName }, templateKey: 'shop:buy.fail_notfound' };
        }

        // 检查库存
        if (targetItem.stock !== -1 && targetItem.stock < amount) {
          return { status: 'fail_stock', data: { itemName }, templateKey: 'shop:buy.fail_stock' };
        }

        // 计算价格 (考虑折扣)
        let unitPrice = targetItem.price;
        if (targetShop.discount_enabled) {
          const isExpired = checkDiscountExpired(targetShop);
          if (!isExpired) {
            unitPrice = Math.floor(unitPrice * (targetShop.discount_value / 100));
          }
        }
        const totalPrice = unitPrice * amount;

        // 检查货币
        const currencyField = targetItem.currency_type || '货币1';
        const takeResult = await services.player.takeCurrency({
          playerId, field: currencyField, amount: totalPrice, source: 'shop:buy'
        });
        if (!takeResult.success) {
          return { status: 'fail_currency', data: {}, templateKey: 'shop:buy.fail_currency' };
        }

        // 执行购买
        
        if (targetItem.stock !== -1) {
          targetItem.stock -= amount;
        }

        const backpackMod = core.getModule('backpack');
        await backpackMod.addItem(playerId, itemName, amount, services);


        await core.db.saveShop(targetShop.name, targetShop);
        core.updateState(`shops.${targetShop.name}`, targetShop);

        return {
          status: 'success',
          data: {
            '购买数量': amount,
            '商品名': itemName,
            '商品价格': totalPrice,
            '货币类型': await services.query.getAlias(currencyField)
          },
          templateKey: 'shop:buy.success'
        };
      },

      'shop:sell': async (request) => {
        const { playerId, args, services } = request;
        const itemName = args[0];
        const amount = 1; // 暂定出售 1 个
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };

        if (!itemName) {
          return { status: 'fail_no_name', templateKey: 'system.invalid_command_usage' };
        }

        // 检查背包是否有此物品
        const backpackMod = core.getModule('backpack');
        if (!backpackMod || !(await backpackMod.getItemCount(playerId, itemName, services) >= amount)) {
          return { status: 'fail_nobackpack', data: { itemName }, templateKey: 'shop:sell.fail_nobackpack' };
        }

        const currentMapName = player.当前地图 || player.初始地图;
        const allShops = await services.query.list('shops');
        const availableShops = allShops.filter(shop => {
          if (!shop.npc_name) return true;
          // 商店有指定 NPC 时，检查 NPC 是否在当前地图
          const npc = core.state.npcs?.[shop.npc_name];
          if (!npc) return true;  // NPC 数据未加载时不过滤，避免误杀
          return npc.map_name === currentMapName;
        });

        let targetShop = null;
        let targetItem = null;
        for (const shop of availableShops) {
          let shopItems = shop.items;
          if (typeof shopItems === 'string') {
            try { shopItems = JSON.parse(shopItems); } catch { shopItems = []; }
          }
          if (!Array.isArray(shopItems)) shopItems = [];
          const item = shopItems.find(i => i.item_name === itemName);
          if (item) {
            targetShop = shop;
            targetItem = item;
            break;
          }
        }

        if (!targetShop) {
          return { status: 'fail_notfound', data: { itemName }, templateKey: 'shop:sell.fail_notfound' };
        }

        // 计算收购价格
        const sellPrice = Math.floor(targetItem.price * (targetShop.acquisition_ratio || 0.5)) * amount;
        const currencyField = targetItem.currency_type || '货币1';

        // 执行出售
        await backpackMod.removeItem(playerId, itemName, amount, services);
        
        await services.player.giveCurrency({
          targets: [playerId], field: currencyField, amount: sellPrice, source: 'shop:sell'
        });

        return {
          status: 'success',
          data: {
            '商品名': itemName,
            '出售价格': sellPrice,
            '货币类型': await services.query.getAlias(currencyField)
          },
          templateKey: 'shop:sell.success'
        };
      }
    ,
      'shop:list': async (request) => {
        const { playerId, args, services } = request;
        const player = await services.player.get(playerId);
        if (!player) return { status: 'fail', templateKey: 'system.player_not_found' };
        const currentMapName = player.当前地图 || player.初始地图;
        const allShops = await services.query.list('shops');
        const availableShops = allShops.filter(shop => {
          if (!shop.npc_name) return true;
          const npc = core.state.npcs?.[shop.npc_name];
          if (!npc) return true;
          return npc.map_name === currentMapName;
        });
        if (availableShops.length === 0) {
          return { status: 'fail_notfound', data: { '商店名': currentMapName }, templateKey: 'shop:list.fail_notfound' };
        }
        const shopName = args[0] || availableShops[0].name;
        const shop = availableShops.find(s => s.name === shopName) || availableShops[0];
        await checkShopRefresh(shop, services);
        let shopItems = shop.items;
        if (typeof shopItems === 'string') { try { shopItems = JSON.parse(shopItems); } catch { shopItems = []; } }
        if (!Array.isArray(shopItems)) shopItems = [];
        const itemLines = shopItems.map(it => {
          const price = shop.discount_enabled ? Math.floor(it.price * (shop.discount_value / 100)) : it.price;
          const currency = services.query.getAlias(it.currency_type || '货币1');
          const stockStr = it.stock === -1 ? '无限' : it.stock;
          return `▫️ ${it.item_name} - 价格:${price}${currency} (库存:${stockStr})`;
        }).join('\n');
        let discountDuration = 0;
        if (shop.discount_enabled && shop.discount_duration > 0 && shop.discount_start_time) {
          const now = new Date();
          const start = new Date(shop.discount_start_time);
          discountDuration = Math.max(0, Math.floor(shop.discount_duration - (now - start) / (1000 * 60)));
        }
        return {
          status: 'success',
          data: {
            '商店名': shop.name,
            '商店介绍': shop.description,
            '商品列表数据': itemLines,
            '商店折扣': shop.discount_enabled ? shop.discount_value : null,
            '折扣持续时间': discountDuration
          },
          templateKey: 'shop:list.success'
        };
      }
  }
  });

  // 导出接口
  const shopExports = {
    getShop: async (name) => await core.db.get('SELECT * FROM shops WHERE name = ?', [name]), // Assuming shops are stored in DB
    listShops: async () => await core.db.all('SELECT * FROM shops'), // Assuming shops are stored in DB
    // 渲染商店列表
    renderShopList: async (shopName, playerId, services) => {
      const shop = await services.query.get('shops', shopName); // Use services.query
      if (!shop) return { status: 'fail_notfound', data: { shopName }, templateKey: 'shop:list.fail_notfound' };
      
      await checkShopRefresh(shop, services); // Pass services

      let shopItems = shop.items;
      if (typeof shopItems === 'string') {
        try { shopItems = JSON.parse(shopItems); } catch { shopItems = []; }
      }
      if (!Array.isArray(shopItems)) shopItems = [];
      const itemLines = shopItems.map(i => {
        const price = shop.discount_enabled ? Math.floor(i.price * (shop.discount_value / 100)) : i.price;
        const currency = services.query.getAlias(i.currency_type || '货币1');
        const stockStr = i.stock === -1 ? '无限' : i.stock;
        return `▫️ ${i.item_name} - 价格:${price}${currency} (库存:${stockStr})`;
      }).join('\n');

      let discountDuration = 0;
      if (shop.discount_enabled && shop.discount_duration > 0 && shop.discount_start_time) {
        const now = new Date();
        const start = new Date(shop.discount_start_time);
        discountDuration = Math.max(0, Math.floor(shop.discount_duration - (now - start) / (1000 * 60)));
      }

      return {
        status: 'success',
        data: {
          shopName: shop.name,
          description: shop.description,
          itemListData: itemLines,
          shopDiscount: shop.discount_enabled ? shop.discount_value : null,
          discountDuration: discountDuration,
          '商店名': shop.name,
          '商店介绍': shop.description,
          '商品列表数据': itemLines,
          '商店折扣': shop.discount_enabled ? shop.discount_value : null,
          '折扣持续时间': discountDuration
        },
        templateKey: 'shop:list.success'
      };
    }
  };

  core.log('info', '商店系统模块加载成功。');
  return {
    moduleName: 'shop',
    ...shopExports
  };
}

shopModule.moduleName = 'shop';
shopModule.dependencies = ['database', 'player', 'backpack'];

module.exports = shopModule;