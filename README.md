# orbit-plugin-pet · 桌宠

一只住在 [Orbit Toolbox](https://github.com/Ikaros-521/orbit-tools) 里的透明桌面小宠物。
待机呼吸、随机溜达、点击 Q 弹、拖拽甩抛，右键换动作——支持**宠物包**扩展更多形象。

灵感与技术源自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DeepSeek Harness 的鲸鱼娘桌宠，MIT）：
本项目把它的桌面模式运行时思路移植到了 Orbit Toolbox 的插件体系上，并重新设计了宠物包格式。
样例形象「小轨」为程序化原创生成（无第三方素材版权问题）：
一颗头顶斜挎发光轨道环的小星灵，金色小卫星沿环绕行——名字里的「轨」长在了身上。

## 安装（Orbit Toolbox 用户）

1. 下载本仓库（Code → Download ZIP，或 `git clone`）
2. 解压/放置到工具箱的**用户插件目录**（设置 → 插件 → 打开用户插件目录），保持文件夹名为 `orbit-plugin-pet` 或任意名均可——工具箱按文件夹内的 `plugin.json` 识别
3. 重启工具箱（或设置 → 插件 → 重新扫描），启用「桌宠」

> 需要工具箱内置 `plugin://` 协议支持 `video/webm`（2026-10 后的版本已支持）。

## 玩法

- **点击**：Q 弹 + 开心跳
- **拖拽**：甩出去会有重力反弹物理
- **双击 + 拉伸 + 释放**：弹弓模式——双击蹲下蓄力，拉出皮筋带，反向发射并旋转
- **投喂文件**：把文件拖到桌宠身上——`.json` 进 JSON 编辑器、`.md/.txt/.log/.csv/.svg` 进备忘录、图片进编码实验室自动预览；不认识的类型它会摇头拒绝
- **待办挂牌**：备忘录里有未勾的任务（`- [ ]`）时头顶亮红角标，点角标直达备忘录；攒得多了它还会开口催
- **右键**：动作菜单 / 说一句 / 回默认位置（弹簧滑翔）/ 隐藏 / 设置
- **设置面板**：大小（120–480px）、宠物包切换、自动溜达、气泡/语音/工作流联动/待办角标开关、回默认位
- 空闲时自己会沿屏幕底边散步，走累了自己回 idle；跑工作流时它会打工、庆祝、难过

## Live2D 宠物（可选引擎）：丢进去就能用

桌宠支持第二种渲染引擎：**把 Live2D 模型文件夹丢进模型库，自动发现成宠物包**——不需要写任何配置。

1. 面板点「打开模型库…」→ 打开 `~/OrbitPet/models/`（默认库）
2. 把整个模型文件夹（内含 `xxx.model3.json`，子目录结构随意，深度 ≤3）放进去
3. 它自动出现在宠物包下拉里（名字取文件夹名；库目录有监听，新增/移除即时刷新，面板也有手动「刷新」兜底），选中即上岗
4. 模型放在别处？「添加模型目录…」把任意盘符的文件夹注册为额外库根（选错层级会自动纠偏），面板可 ✕ 移除

自动发现的映射靠**命名推断**：`Idle*` 组做待机、`Tap*` 组做点击反应、`Wait/Lock` 组做等待、`Work/Walk` 组做打工与溜达、名字带 happy/sad 的表情映射庆祝/难过；没有这些约定就按位置兜底（第一组待机、第二组点击），缺的语义动作会安静回落。想精调（换组、指表情、调贴图缩放），在模型文件夹里放一个 `pet.json` 覆盖即可——只有 `live2d` 映射和 `canvas` 等少数字段需要写，其余全自动：

```json
{ "name": { "zh": "伊卡洛斯（天使）" },
  "live2d": { "click": { "group": "CAT_motion", "index": 1 },
              "celebrate": { "expression": "live2d_expression0.exp3.json", "hold": 2600 } } }
```

模型自带的呼吸/眨眼/目光跟随让 idle 的"活感"通常好于预录视频；拖拽甩抛、弹弓、气泡、工作流联动、锁与回执全部通用。渲染依赖全部本地化在 `vendor/`（pixi MIT / pixi-live2d-display MIT / Cubism Core 专有二进制随应用分发），模型文件**永远不进本仓库**（版权与免责归用户自备）。

## 宠物包格式（做你自己的桌宠）

```
pets/<pack-id>/
├── pet.json     # 清单
└── *.webm       # VP9-Alpha 透明动画（Chromium 可播）
```

`pet.json`：

```json
{
  "id": "orbitian",
  "name": { "zh": "小轨", "en": "Orbitian" },
  "canvas": { "w": 320, "h": 180 },
  "defaultSize": 240,
  "defaultFacing": "right",
  "anims": [
    { "name": "idle",  "file": "idle.webm",  "weight": 4, "role": "idle" },
    { "name": "walk",  "file": "walk.webm",  "role": "walk" },
    { "name": "happy", "file": "happy.webm", "role": "click", "once": true },
    { "name": "sleep", "file": "sleep.webm", "weight": 1, "role": "idle" }
  ]
}
```

- `role`: `idle`（随机轮播池，按 weight 加权）/ `walk`（溜达时播放）/ `click`（点击反应）/ `state`（联动动画：`working` `thinking` `waiting` `celebrate` `error` 五个名字是联动契约，工作流事件与外部 `play` 按名字点播）
- `once`: 播完一次回到 idle 池
- `season: [10, 11]`: 月份门控（1-12），不在季节窗口内时该动画从池子里、右键菜单和 `play` 校验中隐藏——做节日彩蛋用（示例：小轨的 `halloween` 南瓜装）
- `bubbleAnchor: { "x": 0.5 }`: 气泡尾巴指向的画布横向锚点（0-1，默认居中）
- 文件投递路由表、待办角标等工具箱联动是插件本体能力，宠物包无需配置
- 素材生成：`node tools/gen-sample-pet.js` 是「程序化绘制 → ffmpeg 编码 VP9-alpha WebM」的完整参考实现（需要 ffmpeg 在 PATH）。换成你自己的绘制/视频扣绿幕管线即可，输出保持同样的 webm 规格就能被识别
- **注意**：VP9 alpha 编码必须 `-pix_fmt yuva420p -auto-alt-ref 0`；部分 ffmpeg 构建解码不出 alpha 侧数据，以 Chromium 播放为准（`tools/` 里有现成的验证代码）

## DSH 插件兼容（简单适配层）

`compat/pseudo-ctx.js` 实现了 Cordis 插件契约的最小子集（`inject` / `apply(ctx)` /
`ctx.get` / `ctx.set` / `ctx.effect` / `ctx.on`），配合 `mountCordisPlugin()` 可以
挂载**自包含的 DSH 宿主侧插件**（即不依赖 DSH 会话/模型服务的"伴随类"插件）。
依赖 DSH harness 服务的插件（tool / LLM adapter 等）不在目标范围内。

## 开发

```sh
# 冒烟测试（需相邻目录有 orbit-tools 仓库与其 node_modules）
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/smoke.js

# 面板截图（浅/深主题）
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/panel-shot.js
E:/Github_Pro/orbit-tools/node_modules/.bin/electron tools/panel-shot.js --dark

# 重新生成样例宠物素材
node tools/gen-sample-pet.js
```

目录结构：

```
plugin.json          # Orbit Toolbox 插件清单
backend.js           # 主进程：窗口/宠物包/IPC 面/看门狗/碎碎念/锁/投递路由
pet.html/css/js      # 精灵窗口骨架（物理/拖拽/弹弓/气泡/穿透，引擎无关）
motion-webm.js       # 引擎 A：A/B 双缓冲 VP9-alpha 视频
motion-live2d.js     # 引擎 B：pixi + Cubism WebGL（模型目录外部绑定）
vendor/              # pixi / pixi-live2d-display / Cubism Core（许可见其 README）
pet-preload.js       # 沙箱桥（拖放取路径在此，webUtils）
panel.js/css         # 设置面板（宿主 .btn/.input 标准件 + light-dark 令牌）
compat/pseudo-ctx.js # cordis-lite 兼容层
pets/orbitian/       # 样例宠物包（原创程序化生成，webm 引擎）
tools/               # 素材生成 / 冒烟 / 面板截图 / live2d 渲染 spike
```

## Roadmap

- [x] 碎碎念气泡 + 语音朗读（本地语料 + speechSynthesis，v0.2）
- [x] 工作状态联动（workflows 执行 → working/celebrate/error + 气泡播报，v0.3）
- [ ] ai-chat 会话联动 / AI 碎碎念（需要 ai-chat 暴露事件与 provider 面）
- [ ] 多宠同屏 + 碰撞
- [ ] 宠物包导入 UI（选文件夹装填）

完整分期与工程原则见 [ROADMAP.md](ROADMAP.md)。

## License

代码 MIT（含 dsh-pet 技术改编署名，见 LICENSE）。样例形象「小轨」及其生成代码同属 MIT。
