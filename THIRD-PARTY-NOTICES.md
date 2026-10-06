# 第三方资产与许可声明（THIRD-PARTY NOTICES）

本项目（CC Desktop 桌宠）包含以下第三方软件与素材。再分发时请保留本文件及各文件内嵌的版权声明。

## 1. pixi.js v6.5.10 — MIT License

- 文件：`live2d/lib/pixi.min.js`
- 版权：Copyright (c) 2013-2023 Mathew Groves, Chad Engler and the PixiJS contributors
- 主页：https://pixijs.com/ ｜ 仓库：https://github.com/pixijs/pixijs
- 许可：MIT（全文见文末）

## 2. pixi-live2d-display（Cubism 4 集成）— MIT License

- 文件：`live2d/lib/cubism4.min.js`（UMD 打包产物，内含 Live2D Cubism Framework 运行时代码，该部分另受第 3 条 Live2D 许可约束）
- 版权：Copyright (c) 2020 pixi-live2d-display contributors
- 仓库：https://github.com/guansss/pixi-live2d-display
- 许可：MIT（全文见文末）

## 3. Live2D Cubism Core — Live2D 专有软件许可（允许再分发）

- 文件：`live2d/lib/live2dcubismcore.min.js`
- 版权：Copyright (C) 2019 Live2D Inc. All rights reserved.
- 该文件属于 Live2D 许可协议中的 **"Redistributable Code"（可再分发代码）**，完整许可协议见该文件头部声明：
  https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html
- 同协议覆盖第 2 条打包文件中内嵌的 Live2D Cubism Framework 代码。
- Live2D 与 Cubism 为 Live2D Inc. 的商标或注册商标。

## 4. Live2D 样例模型 —— **不包含在本仓库中**

- 官方样例模型（如 Hiyori）的版权归 Live2D Inc. 所有，其再分发受 Live2D Cubism SDK 样例素材使用条款约束，
  因此本仓库**刻意不收录**任何 Live2D 样例模型文件（`.moc3`/贴图/动作等）。
- 如需本地运行 Live2D 形象，请自行从官方渠道下载 Cubism SDK 及样例模型并自行承担合规责任：
  https://www.live2d.com/ （Cubism SDK → Sample Models / Terms of Use）
- 仓库 `.gitignore` 已排除 `live2d/models/Hiyori/`、`live2d/models/Hiyori-2/` 等样例目录。

## 5. 项目作者自有素材

- `skins/1790605732258.gif` 及 `live2d/models/1790605732258/` 下的同一 GIF：本项目作者自有桌宠形象素材，不涉及第三方版权。

---

## MIT License 全文

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
