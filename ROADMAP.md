# 小轨桌宠 · 升级路线图

借鉴 dsh-pet 的机制（不借素材，许可隔离），把小轨从"会动的贴图"养成"工具箱生态的伴侣"。
dsh-pet 锚定 DSH 会话，我们的联动对象换成工具箱自己的状态源（workflows / ai-chat / memo / smart-peek）。

## Phase 1 · v0.2 「会说话」——存在感

- [x] 气泡系统：窗口顶部动态余量（margin = size×0.5，底边锚定地面）+ 气泡层（时长随文本长度、点击关闭、pack 可配锚点）
- [x] 命中区精化：mousemove 判定点（视频区矩形 / 可见气泡）取代整窗 enter/leave，余量空白区保持穿透
- [x] 本地碎碎念语料（时段/久坐等，不碰隐私），3–7 分钟随机节拍；面板「说一句」手动演示
- [x] 语音朗读：从单一 speechSynthesis 升级至 @andresaya/edge-tts 微软高清神经网络语音（晓伊/晓晓/云希等精选发音人、语速/音调调节、面板实时试听、轻量 LRU 缓存、断网自动降级回系统语音）
- [x] 右键菜单扩展：动作点播 / 说一句 / 气泡开关 / 朗读开关 / 隐藏 / 设置
- 顺延至 Phase 2：AI 生成碎碎念（需要 ai-chat 暴露 provider 面）

## Phase 2 · v0.3 「懂你的活」——工具箱状态联动（核心差异化）

- [x] workflows 状态动画：运行中→working、成功→celebrate、失败→error（订阅 core `onWorkflowEvent` 总线；waiting/thinking 素材已备，接入点随 ai-chat）
- [x] 占场锁：dsh-pet 同款契约——acquire/renew/ttl、外部 play/broadcast 必须带 lockId、自播（idle/walk/碎碎念）让路、**用户一碰宠物立即撤锁**
- [x] playbackId 播放回执：pending → playing → done | failed，点播方可 await（`playback` API）
- [x] 事件面配套（core）：WorkflowManager 进程内订阅总线 + run/auto 双路 run-start/run-finish 里程碑（`auto-run` 镜像语义不变）
- [ ] ai-chat 会话联动：生成中→thinking、工具调用→busy、完成→success+气泡摘要（需 ai-chat 暴露事件/状态面，避开并行热区单独立项）
- [ ] 系统通知：workflow 完成 → 通知点击跳回工具箱（open-plugin 路由已有，待接）
- [ ] AI 碎碎念接 ai-chat provider

## Phase 3 · v0.4 「有手脚」——交互深化

- [ ] 文件拖给桌宠（借 dsh-pet file-drop 机制）：json→json-editor、图片→color-lab、文本→memo——桌宠成为工具箱投递入口
- [ ] 待办挂牌（借 todo-bubble：挂头顶、临期提醒加密），接 memo 数据源
- [ ] 物理彩蛋：弹弓双击、弹簧归位（dsh-pet mode=spring）、节日动画池（时间驱动加权事件）
- [ ] 多宠同屏 + 互撞（collision broker 思路；backend 窗口表改 Map）

## Phase 4 · v1.0 「能繁殖」——宠物包生态

- [ ] pack 导入 UI：面板选文件夹/zip → 校验 → 装进用户 pack 目录（需 plugin:// 加 data-dir 路由，唯一核心改动点）
- [ ] 自制管线：gen-sample-pet.js 程序化路线强化（参数化形象、零版权风险）+ 绿幕视频→VP9-alpha ffmpeg 配方文档 + 自写 AI 动画提示词配方（借 dsh-pet 的"按秒分解"方法论，不抄文本）
- [ ] pack 规格冻结：双向素材、音效字段、缩略图、bubbleAnchor
- [ ] Release zip 分发 + 工具箱「从 zip 安装插件」按钮

## 明确不借

余额展示（DSH 语境专属）、网页 overlay（无宿主页面）、Cordis 同页服务（同进程不需要）。

## 工程原则（沿革）

- 移动一律影子坐标 + rAF 合并（v0.1.1 卡顿教训）
- 透明窗渲染技巧沿用 dsh-pet runtime：A/B 双缓冲、pending 释放、forward 穿透、置顶看门狗
- 面板控件用宿主标准件 .btn/.input（v0.1.2 起约定）
- 素材与形象必须自产（程序化或用户自备），避免 dsh-pet 素材的 CC BY-NC-SA 沾染主包
