/**
 * 常量表（2026-09-18 S2 · 治 D13「魔法数字散落」）
 * ------------------------------------------------------------------
 * 这些数字以前以字面量散在 superModule.js 各处：缓存 TTL、调用深度、Guard 上限、
 * 图缓存条数、事件熔断窗口、输出截断、运行历史保留量……
 * 调参只能全仓搜字面量，语义意图也丢了。现在只此一份。
 */
'use strict';

const C = {
  /** 逻辑定义（custom_logic 行）的内存缓存存活时间：保存/删除/改触发词会主动 invalidate */
  CACHE_TTL_MS: 2000,
  /** 「调用函数」嵌套调用的最大深度（超过报 E_DEPTH，防无限递归） */
  MAX_CALL_DEPTH: 10,
  /** Guard：单次执行默认最大步数与超时（逻辑行里的 max_steps / timeout_ms 可覆盖） */
  DEFAULT_MAX_STEPS: 1000,
  DEFAULT_TIMEOUT_MS: 3000,
  /** 图 IR 缓存条数上限（LRU，超出淘汰最旧；同一份图只解析一次） */
  GRAPH_CACHE_LIMIT: 300,
  /** 事件自环熔断：同名事件在窗口内超过次数上限即中断本次派发 */
  EVENT_BURST_WINDOW_MS: 1000,
  EVENT_BURST_LIMIT: 20,
  /** 单次逻辑输出上限（超出截断，防一条消息把群刷爆） */
  MAX_OUTPUT_BYTES: 16000,
  /** 运行历史保留策略（每次核心启动清理一次） */
  RUN_KEEP_COUNT: 2000,
  RUN_KEEP_DAYS: 30,
  /** JS 通道（2026-09-19 · R4/R6）：**JS 自己忙**的时间上限（宿主能力在跑时不计账，
   *  所以 await 等待(3000) / 查询 不会误伤；同步死循环由 vm.timeout 挡） */
  JS_TIMEOUT_MS: 500,
  /** JS 通道：一次调用的**绝对**墙钟上限（含等待与查询；防「等 999 秒」这种写法把自己挂死） */
  JS_TOTAL_TIMEOUT_MS: 20000,
  /** JS 通道：「等待」能力单次最多等多久（毫秒） */
  JS_WAIT_MAX_MS: 5000,
  /** JS 通道：一次调用里最多能调多少次能力（消息/货币/物品/查询…），防 JS 里写死循环把群刷爆 */
  JS_MAX_CALLS: 200,
};

module.exports = C;
