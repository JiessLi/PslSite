# PSL 产品选型清单 MVP

这是第一阶段的轻量版产品选型系统，包含本地登录、角色权限、产品参数表、筛选、在线编辑、CSV/XLSX 导入、模板下载和修改记录。

## 启动

推荐使用 Codex 内置 Python，包含 XLSX 解析依赖：

```powershell
& "C:\Users\LTSC\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" app.py
```

如果只需要 CSV 导入，也可以直接使用系统 Python：

```powershell
python app.py
```

访问：

```text
http://127.0.0.1:8765
```

默认账号：

```text
admin / admin123
```

## 导入模板

页面右上角可以下载 `psl-import-template.csv`。矩阵模板格式：

```csv
group,parameter,unit,A-ZF0100,A-KD0300
产品简介,产品名称,,旋转线 I,精灵线 I
产品简介,产品系列,,翻箱倒料机器人,潜伏机器人
基本参数,长度,mm,1434,800
```

也支持长表格式，字段可使用：

```csv
code,product_name,series,tag,manufacturer,group,parameter,unit,value,filterable
A-ZF0100,旋转线 I,翻箱倒料机器人,食药级,123Robot,基本参数,长度,mm,1434,1
```

## 权限

- 未登录：可查看产品和非成本类参数，成本、售价、报价等敏感参数会隐藏
- 已登录：可查看全部数据，可编辑产品、参数值、表格模板，可导入数据
- `admin`：额外可以维护用户账号

## 文件结构

- `app.py`：后端服务、API、SQLite、导入解析
- `static/index.html`：前端页面结构
- `static/app.js`：前端交互逻辑
- `static/style.css`：页面样式
- `data/psl_selection.db`：本地 SQLite 数据库
- `uploads/`：上传文件留档
