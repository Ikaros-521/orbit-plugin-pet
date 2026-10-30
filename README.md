# orbit-plugin-pet · 桌宠

一只住在 [Orbit Toolbox](https://github.com/Ikaros-521/orbit-tools) 里的透明桌面小宠物。
待机呼吸、随机溜达、点击 Q 弹、拖拽甩抛，右键换动作——支持**宠物包**扩展更多形象。

灵感与技术源自 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（DeepSeek Harness 的鲸鱼娘桌宠，MIT）：
本项目把它的桌面模式运行时思路移植到了 Orbit Toolbox 的插件体系上，并重新设计了宠物包格式。
样例形象「小轨」为程序化原创生成（无第三方素材版权问题）。

## 安装（Orbit Toolbox 用户）

1. 下载本仓库（Code → Download ZIP，或 `git clone`）
2. 解压/放置到工具箱的**用户插件目录**（设置 → 插件 → 打开用户插件目录），保持文件夹名为 `orbit-plugin-pet` 或任意名均可——工具箱按文件夹内的 `plugin.json` 识别
3. 重启工具箱（或设置 → 插件 → 重新扫描），启用「桌宠」

> 需要工具箱内置 `plugin://` 协议支持 `video/webm`（2026-10 后的版本已支持）。

## 玩法

- **点击**：Q 弹 + 开心跳
- **拖拽**：甩出去会有重力反弹物理
- **右键**：动作菜单 / 隐藏 / 打开设置
- **设置面板**：大小（120–480px）、宠物包切换、自动溜达开关、回到默认位置
- 空闲时自己会沿屏幕底边散步，走累了自己回 idle

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

- `role`: `idle`（随机轮播池，按 weight 加权）/ `walk`（溜达时播放）/ `click`（点击反应）
- `once`: 播完一次回到 idle 池
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
backend.js           # 主进程：窗口/宠物包/IPC 面/置顶看门狗
pet.html/css/js      # 精灵窗口渲染端（双缓冲播放/物理/点击穿透）
pet-preload.js       # 沙箱桥
panel.js/css         # 设置面板（light-dark 令牌）
compat/pseudo-ctx.js # cordis-lite 兼容层
pets/orbitian/       # 样例宠物包（原创程序化生成）
tools/               # 素材生成 / 冒烟 / 面板截图
```

## Roadmap

- [ ] 碎碎念气泡（接工具箱 ai-chat 的 provider）
- [ ] 工作状态联动（workflows 执行 → 六档动画）
- [ ] 多宠同屏 + 碰撞
- [ ] 宠物包导入 UI（选文件夹装填）

## License

代码 MIT（含 dsh-pet 技术改编署名，见 LICENSE）。样例形象「小轨」及其生成代码同属 MIT。
