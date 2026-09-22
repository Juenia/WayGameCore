/**
 * 签到系统模块 - 提供每日签到及连签奖励功能
 */
async function signInModule(core) {
  core.log('info', '正在加载签到系统模块...');

  // 1. 初始化数据库表
  // Schema is managed by databaseModule.js

  // 2. 注册系统变量 (用于模板渲染中的 [变量名])
  core.registerSystemVariable('签到奖励', (playerId, core, context) => context.签到奖励 || '');
  core.registerSystemVariable('签到天数', (playerId, core, context) => context.签到天数 || '');
  core.registerSystemVariable('calendar', (playerId, core, context) => context.calendar || '');
  core.registerSystemVariable('time', (playerId, core, context) => context.time || new Date().toISOString().split('T')[0]);

  // 3. 默认配置初始化
  const defaultConfig = {
    baseRewards: [
      { type: 'currency', currencyType: 1, amount: 100 },
      { type: 'exp', amount: 50 }
    ],
    streakRewards: [
      { days: 7, rewards: [{ type: 'item', itemName: '初级药水', quantity: 5 }] },
      { days: 30, rewards: [{ type: 'currency', currencyType: 1, amount: 1000 }] }
    ]
  };

  // 辅助方法：获取签到配置
  const getSignInConfig = async () => {
    let config = await core.db.getEditorSetting('sign_in_config');
    // Ensure config is an object, default to defaultConfig if not
    if (typeof config !== 'object' || config === null) {
      config = { ...defaultConfig }; // Use a shallow copy to avoid modifying defaultConfig directly
    }

    // Ensure baseRewards and streakRewards are always arrays
    if (!Array.isArray(config.baseRewards)) {
      config.baseRewards = [];
    }
    if (!Array.isArray(config.streakRewards)) {
      config.streakRewards = [];
    }
    
    return config; // Always return a valid config object
  };

  // 辅助方法：发放奖励
  const applyRewards = async (playerId, rewards, services) => {
    const received = [];
    let playerChanges = {};

    for (const reward of rewards) {
      if (reward.type === 'currency') {
        const field = services.player.currencyField(reward.currencyType);
        await services.player.giveCurrency({
          targets: [playerId], field, amount: reward.amount, source: 'signIn:sign'
        });
        const alias = core.getAlias(field) || field;
        received.push(`${alias}+${reward.amount}`);
      } else if (reward.type === 'exp') {
        // 经验通过 modify 的增量方式处理
        playerChanges.经验 = { delta: reward.amount };
        received.push(`经验+${reward.amount}`);
      } else if (reward.type === 'item') {
        const backpack = core.getModule('backpack');
        if (backpack && backpack.addItem) {
          await backpack.addItem(playerId, reward.itemName, reward.quantity, services);
          received.push(`${reward.itemName}x${reward.quantity}`);
        }
      } else if (reward.type === 'equipment') {
        const backpack = core.getModule('backpack');
        if (backpack && backpack.addItem) {
          await backpack.addItem(playerId, reward.equipmentName, reward.quantity, services);
          received.push(`${reward.equipmentName}x${reward.quantity}`);
        }
      }
    }
    // 只有当 playerChanges 中有实际修改时才调用 services.player.modify
    if (Object.keys(playerChanges).length > 0) {
        await services.player.modify({ playerId, changes: playerChanges, source: 'signIn:sign' });
    }
    return received.join('，');
  };

  core.registerModule('signIn', {
    doors: [
      { default_triggers: ['签到'], logical_name: 'signIn:sign', description: '每日签到获取奖励' },
      { default_triggers: ['签到日历'], logical_name: 'signIn:calendar', description: '查看本月签到情况' }
    ],
    templates: {
      'signIn:sign.fail_already_done': { text: '❌ 您今天已经签到过了，明天再来吧！', markdown: '❌ 您今天已经签到过了，明天再来吧！' },
      'signIn:sign.success': { text: '✅ 签到成功！\n获得奖励：[签到奖励]\n累计签到：[签到天数] 天\n连续签到：{streak} 天\n日期：[time]', markdown: '✅ 签到成功！\n获得奖励：[签到奖励]\n累计签到：[签到天数] 天\n连续签到：{streak} 天\n日期：[time]' },
      'signIn:calendar.success': { text: '[calendar]', markdown: '[calendar]' }
    },
    handlers: {
      'signIn:sign': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }
    
        const now = new Date();
        const todayStr = now.toISOString().split('T')[0];
        
        // 检查今日是否已签到
        const existing = await core.db.playerDb.get('SELECT * FROM sign_in_records WHERE player_id = ? AND sign_date = ?', [playerId, todayStr]);
        if (existing) {
          return { status: 'fail_already_done', data: {}, templateKey: 'signIn:sign.fail_already_done' };
        }
    
        // 计算连签和累签
        const yesterday = new Date(now);
        yesterday.setDate(now.getDate() - 1);
        const yesterdayStr = yesterday.toISOString().split('T')[0];
        
        const lastRecord = await core.db.playerDb.get('SELECT streak, total FROM sign_in_records WHERE player_id = ? ORDER BY sign_date DESC LIMIT 1', [playerId]);
        
        let streak = 1;
        let total = 1;
        
        if (lastRecord) {
          total = lastRecord.total + 1;
          // 检查最后一次签到是否是昨天
          const lastSignDate = await core.db.playerDb.get('SELECT sign_date FROM sign_in_records WHERE player_id = ? ORDER BY sign_date DESC LIMIT 1', [playerId]);
          if (lastSignDate && lastSignDate.sign_date === yesterdayStr) {
            streak = lastRecord.streak + 1;
          }
        }
    
        // 获取奖励配置
        const config = await getSignInConfig();
        const rewardsToGive = [...config.baseRewards];
        
        // 检查连签奖励
        const streakBonus = config.streakRewards.find(r => r.days === streak);
        if (streakBonus) {
          rewardsToGive.push(...streakBonus.rewards);
        }
    
        // 发放奖励
        const rewardDesc = await applyRewards(playerId, rewardsToGive, services); // Pass services
        
        // 保存记录与玩家数据
        await core.db.playerDb.run('INSERT INTO sign_in_records (player_id, sign_date, streak, total) VALUES (?, ?, ?, ?)', [playerId, todayStr, streak, total]);
    
        // 渲染成功消息
        return {
          status: 'success',
          data: {
            签到奖励: rewardDesc,
            签到天数: total,
            streak: streak,
            time: todayStr
          },
          templateKey: 'signIn:sign.success'
        };
      },
    
      'signIn:calendar': async (request) => {
        const { playerId, args, core, services } = request;
        const player = await services.player.get(playerId);
        if (!player) {
          return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
        }
    
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth(); // 0-11
        const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`;
        
        // 获取当月所有记录
        const records = await core.db.playerDb.all('SELECT sign_date FROM sign_in_records WHERE player_id = ? AND sign_date LIKE ?', [playerId, `${monthStr}%`]);
        const signedDays = new Set(records.map(r => parseInt(r.sign_date.split('-')[2])));
        
        // 生成文字日历
        const firstDay = new Date(year, month, 1).getDay(); // 0 (Sun) - 6 (Sat)
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        
        let calendarText = `📅 ${year}年${month + 1}月 签到日历\n`;
        calendarText += `日 一 二 三 四 五 六\n`;
        
        // 填充第一周空白
        for (let i = 0; i < firstDay; i++) {
          calendarText += `   `;
        }
        
        for (let day = 1; day <= daysInMonth; day++) {
          const isSigned = signedDays.has(day);
          const dayStr = String(day).padStart(2, ' ');
          calendarText += isSigned ? `■ ` : `□ `;
          
          if ((day + firstDay) % 7 === 0) {
            calendarText += `\n`;
          }
        }
        
        return { status: 'success', data: { calendar: calendarText.trim() }, templateKey: 'signIn:calendar.success' };
      }
    }
  });

  core.log('info', '签到系统模块加载完成。');

  return {
    moduleName: 'signIn',
    getSignInConfig,
    applyRewards
  };
}

signInModule.moduleName = 'signIn';
signInModule.dependencies = ['database', 'player', 'backpack'];

module.exports = signInModule;
