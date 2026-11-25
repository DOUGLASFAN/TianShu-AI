# NASA 高清星空

资源：[Deep Star Maps 2020](https://svs.gsfc.nasa.gov/4851/)，Ernie Wright。

署名：NASA/Goddard Space Flight Center Scientific Visualization Studio；Gaia DR2: ESA/Gaia/DPAC。本包不使用星座连线图层。

原始文件为 `starmap_2020_8k.exr`，8192×4096、130,530,278 字节。原件保留在项目 `.local/downloads/sky/`，不随网页分发。来源、原始哈希和每个导出文件的哈希见 `manifest.json`。

网页使用六张 **2048×2048 无损 WebP**，总计约 22 MiB。相较上一版每面 1024px，像素总数提高四倍。这里的“8K”指源全景，不是宣称每个立方体面都有 8K。

转换仅包括双线性球面投影、Reinhard HDR 色调映射和标准 sRGB 编码，没有新增恒星、绘制星云或 AI 改写。使用现有 Cesium SkyBox 渲染，启动时不再逐像素重算天空盒。该背景静态，随镜头产生视角变化，不宣称本身会自动闪烁，也不作精密天体指向依据。

[NASA SVS 使用说明](https://svs.gsfc.nasa.gov/help/)：[NASA 媒体使用指南](https://www.nasa.gov/nasa-brand-center/images-and-media/)。NASA 标志和第三方内容不因本包而获得额外授权；本应用不暗示 NASA 背书。

复现导出时，从项目根目录按 `scripts/sky-tools.requirements.txt` 将工具安装到 `.local/tools/sky-processing`，再运行 `backend/.venv/Scripts/python.exe scripts/prepare_nasa_sky.py`。这些工具仅用于离线转换，应用启动不依赖它们。
