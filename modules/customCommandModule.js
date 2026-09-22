/**
 * 自定义指令模块 - 处理由管理员在编辑器中定义的动态指令
 */
async function customCommandModule(core) {
  core.log('info', '正在加载自定义指令模块...');

  // 委派链守卫：'playerId|trigger' —— 防 A→B→A 交叉委派死循环（2026-09-15）
  const delegationStack = new Set();

  /**
   * 哪个模块把某个触发词声明成了自己的默认触发词（自定义指令模块自己不算）。
   * 用来实现「撞名时把词还给模块」—— 见 syncCommands 里的说明。
   */
  function moduleDeclaring(trigger) {
    const rooms = core.rooms || {};
    for (const mname of Object.keys(rooms)) {
      if (mname === 'customCommand') continue;
      const doors = rooms[mname].doors || {};
      for (const dname of Object.keys(doors)) {
        const d = doors[dname] || {};
        const list = [].concat(d.default_triggers || [], d.aliases || []);
        if (list.indexOf(trigger) >= 0) return { room: mname, door: dname, def: d };
      }
    }
    return null;
  }

  /**
   * 指令帮助菜单（2026-09-22 新增，当天二次重做）
   * 由「自定义指令 + 消息模板」驱动：正文这里现算，排版交给消息模板 customCommand.help。
   * 设计原则：**总览只给分类，不给指令清单** —— 一次把 70 条指令糊上去没人看得下去。
   *   `帮助`            → 分类总览（12 行）
   *   `帮助 任务` / `帮助 6` → 该分类的完整指令
   *   `帮助 全部`       → 一次列全（给老玩家／GM 用）
   * 分类按指令归属模块（room）归组，新加指令会自动出现在菜单里。
   */
  const HELP_CATEGORIES = [
    { rooms: ['player'], title: '角色 · 成长', icon: '🧍' },
    { rooms: ['backpack', 'item'], title: '背包 · 物品', icon: '🎒' },
    { rooms: ['equipment', 'equipmentSet'], title: '装备', icon: '🛡️' },
    { rooms: ['combat', 'skill'], title: '战斗 · 技能', icon: '💥' },
    { rooms: ['profession'], title: '职业', icon: '🎭' },
    { rooms: ['quest'], title: '任务', icon: '📜' },
    { rooms: ['map'], title: '地图 · 移动', icon: '🗺️' },
    { rooms: ['npc', 'shop'], title: 'NPC · 商店', icon: '🏪' },
    { rooms: ['signIn'], title: '每日 · 签到', icon: '📅' },
    { rooms: ['event'], title: '活动', icon: '🎉' },
    { rooms: ['customCommand'], title: '其他', icon: '✨' },
    { rooms: ['core', 'system'], title: '系统', icon: '🛠️' }
  ];
  const HELP_OTHER = { title: '其他', icon: '✨' };

  function parseAliasList(raw) {
    if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
      const v = JSON.parse(raw);
      if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
    } catch (e) { /* 不是 JSON 就按逗号切 */ }
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  function helpCategoryOf(room) {
    for (const c of HELP_CATEGORIES) if (c.rooms.includes(room)) return c;
    return HELP_OTHER;
  }

  /** 把实时指令表整理成「分类 → 指令」模型 */
  async function buildHelpModel(core) {
    const dbCmds = await core.db.getAllCustomCommands();
    const descOf = new Map();
    const disabled = new Set();
    for (const c of dbCmds) {
      if (!c || !c.trigger) continue;
      if (!c.enabled) disabled.add(c.trigger);
      const d = String(c.description || '').trim();
      if (d && !descOf.has(c.trigger)) descOf.set(c.trigger, d);
      for (const a of parseAliasList(c.aliases)) if (a && d && !descOf.has(a)) descOf.set(a, d);
    }

    // 以 core.doorHandles 为准 —— 那才是「真正打得通」的指令表。
    // 同一逻辑的别名各有自己的门把手，但 door 字段指向同一个逻辑名，照 room|door 归组，
    // 否则「提交物品 / submit / tjwp」会各占一行，菜单又长又乱
    // （库里确实还有几条各自成行的老指令，比如 hello / hi / meditate / rest / hp ——
    //   它们的 logical_name 是 customCommand:自己，跟「问候 / 打坐 / 看血」挂不上钩，
    //   这里不猜，保持原样显示）。
    const byDoor = new Map();
    for (const [trigger, h] of Object.entries(core.doorHandles || {})) {
      if (!h || h.enabled === false) continue;
      if (disabled.has(trigger)) continue;
      const room = String(h.room || '');
      const door = String(h.door || trigger);
      const key = room + '|' + door;
      if (!byDoor.has(key)) byDoor.set(key, { room, door, triggers: [], description: '' });
      const g = byDoor.get(key);
      g.triggers.push(trigger);
      if (!g.description && descOf.get(trigger)) g.description = descOf.get(trigger);
    }

    const byCategory = new Map();   // title -> { title, icon, rooms, items: [] }
    for (const g of byDoor.values()) {
      const uniq = [...new Set(g.triggers.filter(Boolean))];
      if (uniq.length === 0) continue;
      // 主名字取模块自己声明的第一个触发词（那才是「官方名」），
      // 取不到再退回最短的中文触发词 → 最短的触发词
      const declared = (core.rooms && core.rooms[g.room] && core.rooms[g.room].doors &&
                        core.rooms[g.room].doors[g.door] &&
                        core.rooms[g.room].doors[g.door].default_triggers) || [];
      let main = declared.find((t) => uniq.includes(t));
      if (!main) {
        const cjk = uniq.filter((t) => /[\u4e00-\u9fa5]/.test(t));
        main = (cjk.length ? cjk : uniq).slice().sort((a, b) => a.length - b.length)[0];
      }
      const cat = helpCategoryOf(g.room);
      if (!byCategory.has(cat.title)) byCategory.set(cat.title, { title: cat.title, icon: cat.icon || '', items: [] });
      byCategory.get(cat.title).items.push({
        main,
        aliases: uniq.filter((t) => t !== main),
        desc: g.description || '',
        room: g.room
      });
    }

    // 按 HELP_CATEGORIES 的顺序输出，没提到的分类排最后
    const order = HELP_CATEGORIES.map((c) => c.title);
    const categories = [...byCategory.values()].sort((a, b) => {
      const ia = order.indexOf(a.title); const ib = order.indexOf(b.title);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });
    for (const c of categories) c.items.sort((a, b) => a.main.localeCompare(b.main, 'zh'));

    return {
      categories,
      total: categories.reduce((n, c) => n + c.items.length, 0)
    };
  }

  /** 分类匹配：支持序号（帮助 6）、名字片段（帮助 任务）、模块名（帮助 quest） */
  function matchHelpCategory(categories, key) {
    const k = String(key || '').trim();
    if (!k) return null;
    const n = parseInt(k, 10);
    if (!isNaN(n) && n >= 1 && n <= categories.length) return categories[n - 1];
    const flat = (s) => String(s).replace(/[\s·・\-—_]/g, '');
    const kk = flat(k);
    return categories.find((c) => flat(c.title).includes(kk)) ||
           categories.find((c) => c.items.some((i) => i.main === k || i.room === k)) ||
           null;
  }

  /**
   * 结构化行（给图片布局的 repeat 节点用）：{ 图标, 标题, 副标题, 备注 }
   * 文本正文与图片卡片共用同一份模型，两边永远一致。
   */
  function buildHelpRows(model, mode, category) {
    const rows = [];
    const pushCat = (c) => rows.push({ 图标: c.icon || '·', 标题: c.title, 副标题: '', 备注: c.items.length + ' 条' });
    const pushItem = (it) => rows.push({
      图标: '·',
      标题: it.main,
      副标题: it.desc || '',
      备注: it.aliases.length ? '（' + it.aliases.join('、') + '）' : ''
    });
    if (mode === 'category' && category) {
      category.items.forEach(pushItem);
    } else if (mode === 'all') {
      model.categories.forEach((c) => { pushCat(c); c.items.forEach(pushItem); });
    } else {
      model.categories.forEach(pushCat);
    }
    return rows;
  }

  /** 分类总览正文：只给分类，不给指令清单（避免一屏 70 行） */
  function renderHelpOverview(model) {
    const lines = model.categories.map((c, i) => {
      return `${i + 1}. ${c.icon ? c.icon + ' ' : ''}${c.title}　${c.items.length} 条`;
    });
    return lines.join('\n');
  }

  /** 单个分类的正文：一条指令一行 */
  function renderHelpCategory(cat) {
    return cat.items.map((it, i) => {
      const alias = it.aliases.length ? `（${it.aliases.join('、')}）` : '';
      const desc = it.desc ? `：${it.desc}` : '';
      return `${i + 1}. ${it.main}${alias}${desc}`;
    }).join('\n');
  }

  /** 「帮助 全部」：一次列全，给老玩家／GM 用 */
  function renderHelpAll(model) {
    return model.categories.map((c) => {
      const head = `${c.icon ? c.icon + ' ' : ''}${c.title}`;
      const rows = c.items.map((it) => {
        const alias = it.aliases.length ? `（${it.aliases.join('、')}）` : '';
        const desc = it.desc ? `：${it.desc}` : '';
        return `- ${it.main}${alias}${desc}`;
      });
      return [head, ...rows].join('\n');
    }).join('\n\n');
  }

  /**
   * 组装帮助菜单：返回给模板用的几个字段
   * @param {string} [keyword] 帮助后跟的第一个参数（分类号 / 分类名 / 全部）
   */
  async function buildHelpText(core, keyword) {
    const model = await buildHelpModel(core);
    const kw = String(keyword || '').trim();

    if (kw && /^(全部|所有|all|list)$/i.test(kw)) {
      return {
        text: renderHelpAll(model),
        rows: buildHelpRows(model, 'all'),
        title: `📖 指令总览 · 共 ${model.total} 条`,
        count: String(model.total),
        categoryCount: String(model.categories.length),
        hint: '输入「帮助」回到分类菜单'
      };
    }

    const cat = matchHelpCategory(model.categories, kw);
    if (cat) {
      const idx = model.categories.indexOf(cat) + 1;
      return {
        text: renderHelpCategory(cat),
        rows: buildHelpRows(model, 'category', cat),
        title: `${cat.icon ? cat.icon + ' ' : ''}${cat.title} · ${cat.items.length} 条指令`,   // 图标跟着分类走
        count: String(model.total),
        categoryCount: String(model.categories.length),
        hint: '输入「帮助」回到分类菜单'
      };
    }

    const missTip = kw ? `没找到「${kw}」这一类，下面是全部分类：\n` : '';
    return {
      text: missTip + renderHelpOverview(model),
      rows: buildHelpRows(model, 'overview'),
      title: `📖 指令帮助 · 共 ${model.total} 条`,
      count: String(model.total),
      categoryCount: String(model.categories.length),
      hint: '输入「帮助 任务」或「帮助 6」看某一类 · 「帮助 全部」一次列全'
    };
  }

  const helpers = {
    /**
     * 依据数据库配置同步所有指令映射
     */
    syncCommands: async (opts = {}) => {
      const dbCommands = await core.db.getAllCustomCommands();
      // onlyCustomRoom：只处理 room=customCommand 的行。
      // 模块加载时先同步一次用它 —— 那会儿别的模块还没加载完，
      // 而核心的绑定规则是「先占者赢」，替别人抢词会把别人的默认触发词挤掉。
      const onlyCustomRoom = !!opts.onlyCustomRoom;

      const doorsToRegister = [];
      const templatesToRegister = {};
      const handlersToRegister = {};

      for (const cmd of dbCommands) {
        if (onlyCustomRoom && String(cmd.room || '') !== 'customCommand') continue;
        let aliases = [];
        if (Array.isArray(cmd.aliases)) {
          aliases = cmd.aliases;
        } else if (typeof cmd.aliases === 'string') {
          aliases = cmd.aliases.split(',').map(s => s.trim()).filter(Boolean);
        }

        // Check if the command or its aliases are already registered by another module
        let shouldRegisterCustom = true;
        const allTriggers = [cmd.trigger, ...aliases];
        for (const t of allTriggers) {
          // 2026-09-19：模块加载时那次「提前同步」跑在核心绑定之前，所以可能是**我们自己**先占了词。
          // 如果这个词其实是某个模块声明的默认触发词，就还给那个模块 ——
          // 恢复「模块默认触发词优先」的最终结果（核心那轮绑定已经因为被我们占了而跳过了它，这里补回来）。
          const declared = moduleDeclaring(t);
          const held = core.doorHandles[t];
          if (declared && (!held || held.room === 'customCommand')) {
            core.doorHandles[t] = {
              room: declared.room,
              door: declared.door,
              enabled: true,
              description: (declared.def && declared.def.description) || '',
              aliases: (declared.def && declared.def.aliases) || [],
              template_key: (declared.def && declared.def.template_key) || ''
            };
            if (held) {
              core.log('warn', `自定义指令「${cmd.trigger}」的触发词「${t}」与模块 ${declared.room} 的 ${declared.door} 撞名 —— 已把该词还给模块（这条自定义指令不会被这个触发词触发）`);
            }
            shouldRegisterCustom = false;
            break;
          }
          if (held && held.room !== 'customCommand') {
            // This command is already registered by another module, skip customCommand registration for it.
            core.log('debug', `指令 '${t}' (属于 '${cmd.trigger}' 自定义指令) 已被其他模块注册，自定义指令模块将跳过注册。`);
            shouldRegisterCustom = false;
            break;
          }
          // 2026-09-19 修（第二次同步会把自定义指令全弄坏）：
          // 这里以前只判 held 存不存在 —— 而**我们自己**上一次同步占下的词也在 doorHandles 里，
          // 于是第二次同步会把每条指令都判成「已被别人注册」而全部跳过，
          // 紧接着 registerModule 传进去的是空的 doors/handlers，而它是**整体替换**房间的：
          // 结果是所有自定义指令的门把手和处理器被一起清空，打指令得到「系统错误：指令处理器 … 未定义」。
          // 现在把自己占的词当作「可以重新注册」，同步变成幂等（模块加载时那次 + core:started 那次都不再互相踩）。
        }

        if (shouldRegisterCustom) {
          // Add to doorsToRegister
          doorsToRegister.push({
            default_triggers: [cmd.trigger, ...aliases],
            logical_name: `customCommand:${cmd.trigger}`, // Unique logical name for custom commands
            description: cmd.description || '自定义指令',
          });
        } else {
          // If we are skipping custom registration, we also don't need to generate a handler or template for it here
          continue; // Move to the next dbCommand
        }

        // Add to templatesToRegister
        let templateContentToRegister = null;
        let templateKeyToRegister = null;

        // Priority 1: template_key referencing a template in message_templates
        if (cmd.template_key) {
          // template_key 形如 room.key（如 customCommand.hello）
          // —— 2026-09-14 修复：按 room.key 拆分查询，并读取正确的列名 text_content/markdown_content
          const seg = cmd.template_key.split('.');
          const templateRow = await core.db.getMessageTemplate(seg[0], seg.slice(1).join('.'));
          if (templateRow && (templateRow.text_content || templateRow.markdown_content)) {
            templateContentToRegister = {
              text: templateRow.text_content || '',
              markdown: templateRow.markdown_content || ''
            };
            templateKeyToRegister = cmd.template_key;
          }
        }

        // Priority 2: reply_template directly from custom command definition
        if (!templateContentToRegister && cmd.reply_template) {
          if (typeof cmd.reply_template === 'string') {
            templateContentToRegister = { text: cmd.reply_template, markdown: cmd.reply_template };
          } else if (typeof cmd.reply_template === 'object' && cmd.reply_template !== null) {
            templateContentToRegister = cmd.reply_template;
          }
          templateKeyToRegister = `customCommandReply:${cmd.trigger}`; // Unique key for this direct template
        }

        // Priority 3: Default hardcoded template
        if (!templateContentToRegister) {
          templateContentToRegister = { text: '指令已执行', markdown: '指令已执行' };
          templateKeyToRegister = `customCommandDefault:${cmd.trigger}`; // Unique key for this default template
        }

        // Register the chosen template
        if (templateContentToRegister && templateKeyToRegister) {
          templatesToRegister[templateKeyToRegister] = templateContentToRegister;
        }


        // Add to handlersToRegister
        const currentCommandTemplateKey = templateKeyToRegister; // Capture for handler
        const currentCommandTemplateContent = templateContentToRegister; // Capture for handler

        handlersToRegister[`customCommand:${cmd.trigger}`] = async (request) => {
          const { playerId, args, core, services } = request;
          // Real-time check if command is disabled
          const allCmds = await core.db.getAllCustomCommands();
          const currentCmd = allCmds.find(c => c.trigger === cmd.trigger);
          if (currentCmd && !currentCmd.enabled) {
            return { status: 'fail_disabled', content: `指令 ${cmd.trigger} 已被管理员禁用。` };
          }

          // 1. Try to execute logical binding
          if (cmd.logical_name) {
            const [targetModuleName, targetLogicalName] = cmd.logical_name.split(':');
            // 自引用守卫（2026-09-15 实机验证）：默认数据把房型指令归一化为
            // logical_name=customCommand:<自身>，若照此递归委派自己会无限递归挂起
            // （打坐/问候/看血曾因此卡死）。自引用视为"无逻辑绑定"，直接走模板回退。
            const selfRef = targetModuleName === 'customCommand' && targetLogicalName === cmd.trigger;
            // 循环守卫：A→B→A 的交叉委派也会死循环，同玩家同指令重入时直接回退模板
            const dk = playerId + '|' + cmd.trigger;
            if (delegationStack.has(dk)) {
              // 已处于该指令的委派链中，放弃再委派，走模板
            } else if (targetModuleName && targetLogicalName && !selfRef) {
              delegationStack.add(dk);
              try {
                // 找到目标门把手的主触发词再委派（避免别名缺失导致的"未知指令"）—— 2026-09-14 修复
                let mainTrigger = null;
                for (const t in core.doorHandles) {
                  const h = core.doorHandles[t];
                  if (h && !h.trigger && h.room === targetModuleName && (h.door === targetLogicalName || h.door === cmd.logical_name)) { mainTrigger = t; break; }
                }
                const fullCommandText = `${mainTrigger || targetLogicalName} ${args.join(' ')}`.trim();
                const result = await core.handleCommand(playerId, fullCommandText);
                if (result) {
                  // 委派结果自带渲染好的 content，直接回传，不再走外层模板查找 —— 2026-09-14 优化
                  return { status: result.error ? 'fail' : 'success', content: result.content || '', data: result.data };
                }
              } finally {
                delegationStack.delete(dk);
              }
            } else {
              // If it's a logical_name without a module prefix, try to find it in the current module's handlers
              // Or, if it's a logical_name that maps to a global handler (like old core.logicHandlers), this part needs more info.
              // For now, let's assume if it has a logical_name, it's either delegated or falls through to template.
            }
          }

          // 2. Fallback to registered template
          const player = await services.player.get(playerId);
          if (!player) {
            return { status: 'fail_player_not_found', data: {}, templateKey: 'system.player_not_found' };
          }

          // 帮助菜单：模板里真的用到 {指令帮助} / {指令总数} 时才现算（别的指令零开销）—— 2026-09-22
          const runtimeData = {
            player,
            args,
            commandName: cmd.trigger
          };
          const probe = String((currentCommandTemplateContent && currentCommandTemplateContent.text) || '') +
                        String((currentCommandTemplateContent && currentCommandTemplateContent.markdown) || '');
          if (probe.includes('指令帮助') || probe.includes('指令总数')) {
            // args[0] 可以是分类号（帮助 6）、分类名（帮助 任务）或「全部」
            const help = await buildHelpText(core, args && args[0]);
            runtimeData['指令帮助'] = help.text;
            runtimeData['帮助标题'] = help.title;
            runtimeData['帮助提示'] = help.hint;
            runtimeData['指令总数'] = help.count;
            runtimeData['分类数量'] = help.categoryCount;
            // 图片布局（customCommand/help）用这行做 repeat 数据源
            runtimeData['帮助列表JSON'] = JSON.stringify(help.rows || []);
          }

          return {
            status: 'success',
            // 注意：不要把 core 塞进 data（含定时器等循环结构，会导致序列化崩溃）—— 2026-09-14 修复
            data: runtimeData,
            templateKey: currentCommandTemplateKey
          };
        }
      }

      // 2026-09-19：registerModule 会把注册表里的 file_path 写成「当前装载上下文」——
      // 而本模块这次调用是在 core:started 之后（装载上下文早已结束），会被写成 'unknown'，
      // 于是「重载模块 customCommand」直接回「无有效文件路径，无法重载」。
      // 先把原来那份有效路径记下来，注册完再还回去（只动元数据，不碰运行状态）。
      const __prevInfo = core.moduleRegistry && core.moduleRegistry['customCommand'];
      const __prevPath = (__prevInfo && __prevInfo.file_path && __prevInfo.file_path !== 'unknown') ? __prevInfo.file_path : null;

      // Register the customCommand module with the updated dynamic commands/templates/handlers
      // This will overwrite previous registrations for 'customCommand' module, which is what we want for dynamic updates.
      core.registerModule('customCommand', {
        doors: doorsToRegister,
        templates: templatesToRegister,
        handlers: handlersToRegister,
      });

      if (__prevPath) {
        const __now = core.moduleRegistry && core.moduleRegistry['customCommand'];
        if (__now && (!__now.file_path || __now.file_path === 'unknown')) __now.file_path = __prevPath;
      }

      // 将注册的门把手直接写入 core.doorHandles：
      // 核心的 syncCommandBindings 在 core:started 之前运行，不会再处理此后的 _pendingBindings
      // —— 2026-09-14 修复 customCommand 房型指令路由（打坐/问候/看血）
      for (const d of doorsToRegister) {
        const mainTrigger = d.default_triggers[0];
        const entry = {
          room: 'customCommand',
          door: d.logical_name,
          enabled: true,
          description: d.description || '',
          aliases: d.default_triggers.slice(1),
          template_key: ''
        };
        core.doorHandles[mainTrigger] = entry;
        for (const a of d.default_triggers.slice(1)) {
          if (!core.doorHandles[a]) core.doorHandles[a] = { ...entry, trigger: mainTrigger };
        }
      }

      core.log('info', `自定义指令系统同步完成：已更新 ${dbCommands.length} 条自定义指令映射。`);
    }
  };

  // 2026-09-19 修（启动瞬间打不了自定义指令）：
  // 现象（实证）：核心 start() 刚返回就打「打坐/问候/看血/hp」→ 4/8 条全是「未知指令」，
  //   等 300ms 再打就 8/8 正常。原因：下面 core:started 里那次同步是 async，核心 emit 时**不等它**，
  //   于是 start() 返回后还有一段窗口期，自定义指令的门把手没挂上。
  // 做法：模块加载时就**同步一次**（只同步 room=customCommand 的行 —— 此刻别的模块还没加载完，
  //   不能替它们抢词）；core:started 里那次仍然保留，作为「所有模块都加载完」之后的权威再同步。
  await helpers.syncCommands({ onlyCustomRoom: true });
  core.log('info', '自定义指令：模块加载时已完成一次同步（启动即可用）。');

  // Listen for core:started event to resync after all other modules are loaded
  core.on('core:started', async () => {
    await helpers.syncCommands();
  });

  core.log('info', '自定义指令模块加载成功。');

  return {
    moduleName: 'customCommand',
    ...helpers
  };
}

customCommandModule.moduleName = 'customCommand';
customCommandModule.dependencies = ['database'];
module.exports = customCommandModule;