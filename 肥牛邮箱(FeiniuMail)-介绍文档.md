# 肥牛邮箱（FeiniuMail）

> 运行在 NAS 上的网页版邮件客户端 —— 让每一封邮件都安全留存在你自己的设备里。

肥牛邮箱是一款**专为飞牛 OS（fnOS）打造**的网页版邮件客户端。它提供「飞牛桌面窗口」与「独立 IP:端口」双入口，只需浏览器即可轻松收发邮件、管理多账号与通讯录。**所有邮件正文与附件均强制保存在 NAS 本地**，绝不经过任何第三方服务器中转。本应用为第三方开源项目，非飞牛官方出品。

---

## 一、主要功能

### 1. 收信与本地永久归档
- 完整支持 **POP3** 与 **IMAP** 协议，提供定时自动后台收取与手动一键同步。
- 每一封收到的邮件都会连同附件一起，以独立的 **`.eml` 原文格式**落盘保存至 NAS。
- 采用「只增不减」的同步逻辑：已读状态只升级不回退，无惧因定时同步导致已读邮件被反复重置为未读。

### 2. 发信与已发送溯源
- 基于 **SMTP** 协议发信，完整支持抄送（CC）、密送（BCC）与超大附件（单封最高合计 100 MB）。
- 发出的所有邮件均在本地生成「已发送」副本，与收件箱数据统一归档、全局检索。
- 发送前自动在底层剥离密送头信息，从根本上杜绝密送名单被泄露。

### 3. 高效通讯录
- 内置轻量化通讯录，支持下载标准模板并通过 **CSV 批量导入**（自动按邮箱去重，单次支持 5000 条）。
- 智能联想输入：在收件人/抄送区键入姓名或邮箱片段，实时弹出候选列表，支持键鼠快捷选中。
- 兼容多种分隔符（逗号、分号、换行），轻松应对从外部 Excel 或文本中直接粘贴群发名单的场景。

### 4. 访问与底层安全
- 首次部署需初始化访问口令，后续所有访问均需进行严格的口令鉴权。
- 邮箱密码及敏感配置均采用密文加密存储，告别明文泄漏风险。
- 默认隔离邮件正文中的远程图片与外部追踪资源，有效防御钓鱼邮件与隐私嗅探。

### 5. 极简部署与运维
- 纯 Python3 标准库开发，**零第三方库依赖**，无需折腾复杂的运行环境。
- 提供独立配置向导，安装阶段自动进行**端口占用检测**，避免系统冲突。

---

## 二、核心优势

### 1. 告别「换机丢邮件」，数据永不离线
传统客户端（如 Foxmail、Outlook）将数据与单台电脑深度绑定，一旦面临重装系统、硬盘损坏或更换设备，数据迁移极易发生残缺。
肥牛邮箱是**纯 NAS 端应用**，邮件资产统一托管在 NAS 端。无论你换电脑、换系统还是重装浏览器，只要打开网页，历史邮件和通讯录就在那里。无需任何导入导出，无需漫长重步。

### 2. 依托 NAS 级高可靠性，逐封永久留存
每封邮件均以标准 `.eml` 原文落盘，这使得你的邮件目录能直接享受 NAS 系统自带的数据保护红利 —— RAID 阵列冗余、定时快照、异地备份、云盘同步策略均可无缝覆盖。你的邮件资产将享有与珍贵照片、重要文档同等级的最高安全保障。

### 3. 拒绝第三方中转，真正的数据主权
整条链路仅在你的终端、NAS 与邮件服务商之间闭环运作。没有中间商的二次缓存，也没有第三方云端的数据分析。数据主权 100% 归属你自己，高度契合注重隐私与合规要求的用户。

### 4. 无惧服务商容量限制与清理策略
邮件一旦安全着陆于 NAS，便彻底摆脱了原邮箱的容量紧箍咒和自动清理规则。哪怕原邮箱网盘告急，哪怕服务商定期清空旧数据，你的本地归档依然毫发无损。

### 5. 覆盖安装，无痛升级
安装包极致轻量，维护成本极低。后续版本升级完美支持**覆盖安装**：内部数据目录与账号配置原地保留，升级后所有邮件、账号、通讯录无缝延续，不折腾。

---

## 三、安装指南

肥牛邮箱专为飞牛 OS 设计，安装过程极其简便，仅需两步：

1. **获取安装包**：在项目发布页下载最新版本的 `.fpk` 格式应用包。
2. **手动安装**：
   - 登录您的飞牛 OS 桌面，打开「**应用中心**」。
   - 点击右上角（或菜单栏）的「**手动安装**」按钮。
   - 选择并上传刚刚下载的 `.fpk` 文件。
   - 跟随向导简单配置服务端口，点击完成即可一键部署。

---

## 四、适用场景

> **核心前提**：本应用为飞牛 OS（fnOS）专属的 `.fpk` 应用，**必须在飞牛 OS 环境下运行**。暂不支持其他操作系统或其它品牌的 NAS 系统。

在满足上述前提下，肥牛邮箱完美契合以下人群与场景：

- **数字资产囤积者**：希望将散落在多台电脑、多个客户端上的工作/个人历史邮件，集中沉淀到 NAS 进行长久且统一管理的用户。
- **「空间焦虑」患者**：原有邮箱服务商（如免费版企业邮箱）容量告急，需要一个无限容量的本地归档中心来释放云端空间的用户。
- **隐私与数据主权至上者**：处理敏感商业机密的小型团队或个人，绝不接受邮件被第三方邮件客户端云服务抓取、缓存或分析。
- **旧邮箱数据迁移备份**：准备离职或停用某个旧邮箱账号前，希望将所有历史往来邮件完整打包并安全留存在本地的用户。
- **多终端/多账号切换频繁者**：拥有多台设备（手机、平板、办公本），或者需要同时管理多个邮箱账号，希望在一个网页内就能跨设备获得完全一致的收发体验的用户。

---
---

# FeiniuMail

> A web-based email client designed for your NAS — keeping every message safely stored on your own device.

FeiniuMail is a dedicated email client built **exclusively for Feiniu OS (fnOS)**, delivered as a seamless web application. It provides both a native Feiniu desktop-window entry and direct `IP:port` access, allowing you to manage emails, multi-accounts, and contacts directly from your browser. **All email bodies and attachments are strictly saved locally on your NAS**, bypassing any third-party relay servers. Please note: This is a third-party open-source application and is not an official Feiniu product.

---

## 1. Key Features

### 1.1 Seamless Receiving & Permanent Archiving
- Fully supports **POP3** and **IMAP** protocols, featuring both scheduled background sync and one-click manual fetch.
- Every incoming message is independently archived to your NAS as an original **`.eml`** file, with all attachments saved alongside.
- Adopts an "upgrade-only" read state logic: read statuses are only advanced, never rolled back. Scheduled syncs will never rudely mark your already-read emails as unread.

### 1.2 Secure Sending & Sent-Mail Retention
- Dispatches emails via **SMTP**, fully supporting CC, BCC, and large attachments (up to 100 MB per message).
- All outgoing emails are retained in a local "Sent" folder, universally searchable alongside your inbox archive.
- BCC headers are automatically stripped at the core level before dispatch, mathematically eliminating the risk of exposing blind recipients.

### 1.3 Efficient Address Book
- Features a lightweight built-in contact manager. Supports **bulk CSV imports** (up to 5,000 rows per batch, automatically deduplicated by email address) with a downloadable template.
- Smart suggestions: Typing a name or email fragment in the To/CC/BCC fields instantly triggers a live dropdown list, easily navigable via keyboard or mouse.
- Highly flexible recipient fields accept commas, semicolons, and line breaks, making copy-pasting bulk lists from Excel or external texts a breeze.

### 1.4 Hardened Access & Security
- A mandatory access passcode is established on first launch, ensuring strict authentication for all future visits.
- All mailbox passwords and sensitive configurations are encrypted at rest. No plaintext leaks, ever.
- Remote images and external tracking pixels in email bodies are blocked by default, effectively shielding you from phishing attempts and privacy sniffers.

### 1.5 Painless Deployment & Maintenance
- Developed using pure Python 3 standard libraries with **zero third-party dependencies**. No messy runtime environments required.
- The built-in setup wizard automatically performs **port-occupancy checks** during installation to prevent system conflicts.

---

## 2. Core Advantages

### 2.1 Say Goodbye to Data Loss When Switching Devices
Traditional clients (like Outlook or Thunderbird) bind your data to a single machine. If your hard drive crashes or you reinstall your OS, migrating that data is often a nightmare. 
FeiniuMail is a **pure NAS-native application**. Your email assets are hosted centrally on your NAS. Switch computers, change operating systems, or reinstall browsers — simply open the web UI, and your historical emails and contacts are exactly where you left them. No export, no import, no endless syncing.

### 2.2 Enterprise-Grade Reliability for Every Message
Because each email is saved as a standard `.eml` file, your mail directory inherits all the built-in data protection benefits of your NAS. RAID redundancy, scheduled snapshots, off-site backups, and cloud sync policies natively cover your inbox. Your emails enjoy the exact same top-tier security as your irreplaceable photos and crucial documents.

### 2.3 True Data Sovereignty, No Intermediaries
The entire communication loop is strictly between your device, your NAS, and your email provider. There are no third-party cloud caches and no external data analysis. Your data sovereignty is 100% yours, making it the perfect solution for privacy-conscious users and compliance-heavy workflows.

### 2.4 Unbound by Provider Storage Limits & Purge Policies
Once your email safely lands on your NAS, it breaks free from the storage quotas and auto-cleanup rules of your email provider. Even if your cloud inbox fills up or the provider routinely deletes old emails, your local archive remains completely intact and infinite.

### 2.5 Hassle-Free Upgrades
The application package is incredibly lightweight. Future updates support **seamless in-place over-installs**: your internal data directories and account settings remain untouched. Upgrading carries over all your emails, accounts, and contacts without any friction.

---

## 3. Installation Guide

FeiniuMail is specifically tailored for Feiniu OS, making installation a breeze:

1. **Download the Package:** Grab the latest FeiniuMail `.fpk` application file from the project's release page.
2. **Manual Installation:**
   - Log into your Feiniu OS desktop and open the "**App Center**" (应用中心).
   - Click the "**Manual Install**" (手动安装) button located in the top-right corner or menu.
   - Select and upload the downloaded `.fpk` file.
   - Follow the simple wizard to configure your service port, click complete, and your deployment is ready to go.

---

## 4. Who is it for?

> **Prerequisite:** FeiniuMail is a dedicated `.fpk` package and **requires Feiniu OS (fnOS) to run**. Other operating systems and NAS brands are currently not supported.

Provided you meet the prerequisite, FeiniuMail is perfect for:

- **Digital Hoarders / Archivists:** Individuals looking to consolidate years of scattered emails from multiple PCs into a single, permanent NAS repository.
- **Users Hitting Storage Quotas:** People running out of space on free-tier or enterprise email providers, needing an unlimited local archive to free up cloud storage.
- **Privacy Advocates & Small Teams:** Professionals dealing with sensitive commercial data who refuse to let third-party cloud mail clients crawl, cache, or analyze their communications.
- **Migration & Backup Seekers:** Users planning to shut down, leave, or migrate away from an old email account, who need to securely download and indefinitely preserve all historical correspondence beforehand.
- **Multi-Device Power Users:** People juggling multiple devices (phones, tablets, work laptops) or managing multiple email accounts, seeking a universally consistent web-based inbox experience without installing clients everywhere.