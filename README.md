# 在线听歌 · 服务器部署版

多音源聚合音乐播放器，自带后端代理（解决浏览器跨域 + 接口统一）。
支持音源：网易云 / 酷我 / 酷狗 / QQ音乐 / 汽水音乐 / 咪咕音乐 / JOOX。

## 一、环境要求

- Node.js **14 或更高**（推荐 18 LTS）
- 不需要数据库，不需要 `npm install`（零第三方依赖）

检查：`node -v`

## 二、上传与启动

把整个文件夹上传到服务器，例如 `/www/wwwroot/music`，然后：

```bash
cd /www/wwwroot/music
node server.js
```

看到下面的提示就说明起来了：

```
在线听歌 · 音源代理服务已启动
请在浏览器打开： http://127.0.0.1:8898
服务器/局域网访问： http://<本机IP>:8898
```

## 三、访问

- 默认端口 **8898**，默认监听 `0.0.0.0`（外网可直接访问）
- 浏览器打开：`http://你的服务器IP:8898`
- **记得在云服务器安全组 / 防火墙放行 8898 端口**

换端口：

```bash
PORT=9000 node server.js
```

只允许本机访问（配合 Nginx 反代时用）：

```bash
HOST=127.0.0.1 node server.js
```

## 四、常驻后台运行

### 方式 1：pm2（推荐）

```bash
npm install -g pm2
pm2 start server.js --name music
pm2 save
pm2 startup      # 按提示执行它输出的那行命令，开机自启
```

常用：`pm2 restart music` / `pm2 logs music` / `pm2 stop music`

### 方式 2：nohup（最省事）

```bash
nohup node server.js > music.log 2>&1 &
```

### 方式 3：systemd（Linux 开机自启）

新建 `/etc/systemd/system/music.service`：

```ini
[Unit]
Description=Online Music Player
After=network.target

[Service]
Type=simple
WorkingDirectory=/www/wwwroot/music
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3
Environment=PORT=8898

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now music
```

## 五、Nginx 反向代理（可选，想要域名 / 80 端口时用）

```nginx
server {
    listen 80;
    server_name music.example.com;

    location / {
        proxy_pass http://127.0.0.1:8898;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 120s;
    }
}
```

配合反代时建议后端加 `HOST=127.0.0.1`，避免 8898 直接暴露在外网。

> 用「歌单云备份」的话，Nginx 默认 `client_max_body_size 1m` 够用（一个歌单约 20KB），但如果有人歌单特别大（几千首），在 `location` 里加一行 `client_max_body_size 4m;` 更稳。

### 想挂在已有网站的子目录（如 `http://你的域名/music/`）

```nginx
location /music/ {
    proxy_pass http://127.0.0.1:8898/;   # 结尾的 / 不能少
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_read_timeout 120s;
}
```

前端接口是**相对路径**，会自动跟着走 `/music/api`，不用改任何代码。

## 六、目录说明

```
├── server.js      # 后端：音源代理（端口 8898）
├── index.html     # 前端：单文件页面（Vue 3）
├── lib/           # 前端依赖（已本地化，不依赖 CDN）
│   ├── vue.global.prod.js
│   ├── localforage.min.js
│   ├── pako.min.js
│   └── fontawesome/
├── package.json
└── data/          # 首次运行自动创建，存放歌单云备份
    └── plists/    # 每个备份码一个 json（如 7k2mqv3x.json）
```

## 七、注意事项

- **自建歌单 / 播放列表 / 主题设置默认存在浏览器本地**（localforage），本身不出这台设备；只有开了「歌单云备份」之后，歌单才会多存一份到服务器的 `data/plists/` 里（按备份码存取）。
- **歌单云备份（换手机用备份码取回，推荐给家人朋友用）**：「歌单」页「我的歌单」标题右边第 4 个云朵图标——点开「歌单云备份」→「生成备份码并上传」，会得到一串 8 位码（如 `7k2mqv3x`），自动复制到剪贴板。把这串码记在备忘录/截图就行，**不用注册、不用登录、不用懂 GitHub**。换手机后在新设备上打开同一个网址，输入这串码点「取回」，歌单就回来了，点开照样能播（播放地址是点下去实时取的）。
  - 绑定后**每次改歌单都会自动备份一次**（2.5 秒防抖），平时不用管；也可在弹层里点「立即备份」。
  - 服务端接口：`POST /api?types=saveplist&code=XXXX`（body 传 `{myPlaylists,playList}`）、`GET /api?types=loadplist&code=XXXX`。数据落在 `data/plists/<code>.json`，只存元数据（平台 + 歌曲 id + 歌名等），不含音频。
  - **备份码就是钥匙**：8 位随机（去掉了容易看错的 i/l/o/0/1），别人拿到码能读也能覆盖你的歌单，所以别发到公开群里。任何人知道码就能取，服务端不做账号体系是刻意的——就是为了让不懂技术的人一秒钟上手。
  - `/data/` 路径已被服务端 403 拦掉，只能通过 `types=loadplist` 按码取，不能直接下载或列目录。
  - 迁移服务器时记得把整个 `data/` 目录一起搬走，否则大家原来的备份码就失效了；目录必须**可写**，否则上传会提示「写入失败」。
- **歌单导出 / 导入 JSON（离线备份）**：「我的歌单」标题右边还有**导出**（下载 `歌单备份-YYYYMMDD.json`）和**导入**（选一个 json 文件合并）两个图标。JSON 里只存 `source + id + 歌名/歌手/专辑/时长`，**不含音频、不含播放地址**，100 首约 20KB，可以丢进 GitHub 仓库、网盘当冷备份。
  - 导入是**按歌单名合并**：同名歌单会把新歌并进去、已有的同源同 id 歌曲自动跳过，不会产生重复；纯数组格式（`[{name,songs:[...]}]`）也认得。
  - 导入时如果当前播放列表是空的，会顺手把备份里的播放列表补回来；非空则不动，避免打乱正在听的顺序。
  - 云备份和 JSON 导出可以同时用：云备份管日常换手机，JSON 管"彻底跑路"（后端没了也能靠它恢复）。
- **点开歌单自动播放**：「我的歌单」标题右边第 3 个圆形播放图标是开关（默认关，开启后按钮高亮，状态存本地）。开启后点歌单卡片会直接进详情并播放第一首；关闭时只浏览不打扰正在听的歌。
- **歌单里的歌按它自己的平台播**：JSON / 本地记录里每首歌都带 `source`（netease / tencent / kugou / kuwo / qishui / migu），点哪首就用哪个平台取链，**跟顶部搜索框选的"音源"无关**。所以从 QQ 收藏的歌走 QQ 播、网易云收藏的走网易云播；若那首在该平台下架或拿不到地址，会自动换到其它平台同名版本并在右上角提示。
- **自建歌单怎么用**：底部标签「歌单」页顶部就是「我的歌单」，点「新建歌单」可建空歌单；在搜索结果、排行榜、歌单详情里点歌曲右边的 **♡** 收藏进来（播放器右侧的 ♥ 收藏当前歌曲）。歌单详情可「播放全部」、重命名、删除，单曲可移出。同名同源的歌不会重复收藏。
- 播放地址是各平台临时直链，**有有效期**，由前端实时获取，不需要服务器存储。
- **音质说明**：酷狗、QQ、咪咕的高音质（320K / 无损）由第三方聚合服务提供，酷狗可到无损与 Hi-Res，QQ 的 320K 可用（无损需对方卡密），咪咕 VIP 曲多数也能拿到 320K。第三方服务不可用时自动回退到官方匿名接口（酷狗 / QQ 为 128K），仍可正常播放。
- 汽水音乐走官方 web 接口，音频是 AAC，三档 65K / 129K / 257K，**最高约 256K，这是平台天花板**，不是被限速；它确实有 lossless / hi_res 档位，但属于会员权益，匿名接口不返回地址。256K AAC 的实际听感大致相当于 320K MP3，所以**汽水不做自动换源**，避免把汽水独家的版本换成别的平台。其 CDN 有防盗链，音频经 `/stream` 由本服务转发，**不要关掉后端只开静态页**。
- 选中 320K / 无损时，如果当前源给不到（比如酷狗 / QQ 匿名只给 128K），会自动到酷我 / 网易云 / 咪咕 / 酷狗 / QQ 找同名的更高码率版本顶上（并行查询，通常 1 秒内出结果），命中后右上角会提示换源结果。
- 咪咕官方取链接口需要签名，因此咪咕依赖上面的第三方聚合服务；服务不可用时咪咕会取不到直链，前端会自动换到其他音源。
- 所有音源均为各平台公开接口，仅供个人学习与自用。
