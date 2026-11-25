# 通用卫星预览素材

下载日期：2026-11-15。文件：`satellite.glb`，335,620 字节（约 328 KiB）。

原模型：Geostationary Operational Environmental Satellites（GOES）。
作者署名：**NASA/Christopher R. Meaney**。

- [NASA 模型介绍](https://science.nasa.gov/3d-resources/geostationary-operational-environmental-satellites/)
- [NASA 资源使用指引](https://www.nasa.gov/nasa-brand-center/images-and-media/)
- [NASA 3D 资源说明](https://science.nasa.gov/3d-resources/)

NASA 资源页提供免费下载与使用，使用时遵守其媒体使用指引，保留来源署名，不暗示 NASA 为本项目背书。本文件不将其另行标记为 CC 或 MIT 许可。

## 项目用途

作为右侧卫星详情的通用三维外形示意。模型原型是 GOES，不能将它宣称为 ISS、北斗或所有所选对象的真实外形；展示朝向也不是卫星实时姿态。接入后将“通用示意”放在模型可访问名称或来源说明中，避免增加常驻解释段落。

## 文件检查

原件未修改。已核验 GLB 2.0 文件头、声明长度、JSON 场景与网格；模型包含材质，无外部贴图或缓冲文件引用。模型使用 `KHR_draco_mesh_compression`，加载器需配置本地 Draco 解码器；不能将未解码直接加载失败误判为缺少贴图。

模型包含约 40,935 个三角面、24 个材质。下载地址、SHA-256 和结构检查结果见 `manifest.json`。当前完成的是素材准备，尚未替换应用图标或完成浏览器渲染验收。

2026-11-15 接入补记：已通过 Three.js 与本地 Draco 解码器接入右侧预览，原件未修改。支持拖动、缩放、方向键和重置视角，按需重绘，离开页面释放资源。模型仅作通用示意，来源说明在详情“数据来源”中展开。[实际浏览器检查](../../../docs/evidence/satellite-preview-2026-11-15.json)包含加载、操作、资源重建和失败重试验证。
