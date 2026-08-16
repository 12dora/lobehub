# 钉钉登录（`dingtalk` 登录方式）接入手册

> 适用场景：不经过 Authentik，直接让成员用**钉钉账号**登录 AIHub。
> 全部配置在 **管理后台 → 安全与认证 → 登录方式** 完成，无需环境变量、无需改配置文件。
> 若企业已有 Authentik（上游对接钉钉），请继续使用 [authentik-setup.md](./authentik-setup.md)；两者可并存，登录页会各显示一个按钮。

## 1. 它与其它登录方式的区别

`platform_identity_providers.type` 现在支持三种 kind：

| kind           | 协议                 | 发现文档 | id\_token | PKCE   | 邮箱               |
| -------------- | -------------------- | -------- | --------- | ------ | ------------------ |
| `authentik`    | OpenID Connect       | 必需     | 必需      | 必需   | 必需               |
| `generic_oidc` | OpenID Connect       | 必需     | 必需      | 必需   | 必需               |
| `dingtalk`     | 纯 OAuth 2.0（钉钉） | **无**   | **无**    | 不支持 | 常常没有，自动合成 |

钉钉不发布 `/.well-known/openid-configuration`，不签发 `id_token`，用户资料接口用
`x-acs-dingtalk-access-token` 头而非 OIDC 的 `Bearer`。这四点差异被**只**在
`dingtalk` 这一 kind 上放开，两种 OIDC kind 的行为逐字未变。放开点集中在：

- `apps/server/src/enterprise/services/identityProvider/kinds/dingtalk.ts`（协议实现：端点、令牌交换、资料读取、声明投影、企业允许列表判定）
- `src/libs/better-auth/sso/platformDingTalkProvider.ts`（Better Auth 运行时适配）

### 固定不可改的身份契约

下列内容由协议固定，**不是**可编辑的模板 —— 服务端在写入（create/update 的 zod 校验）与读取
（发布快照 / LKG 解析）两处都会强制校验，API 直连也改不了：

| 项          | 值                                                                        |
| ----------- | ------------------------------------------------------------------------- |
| issuer      | 必须恰好是 `https://login.dingtalk.com`                                   |
| 授权        | `https://login.dingtalk.com/oauth2/auth`（`prompt=consent`）              |
| 令牌        | `https://api.dingtalk.com/v1.0/oauth2/userAccessToken`（JSON body）       |
| 用户资料    | `https://api.dingtalk.com/v1.0/contact/users/me`                          |
| Scope       | 必须恰好是 `openid corpid`                                                |
| 账号标识    | `unionId`（**必需**；缺失即拒绝登录）                                     |
| 昵称 / 头像 | `nick` / `avatarUrl`                                                      |
| 邮箱        | 钉钉返回则使用（转小写）；否则合成 `<unionId>@<providerKey>.dingtalk.sso` |

> 为什么 `unionId` 不能回退到 `openId`：`openId` 是**按应用**分配的，一旦更换 AppKey 就会变，
> 老账号会被重新绑定到别人身上。缺 `unionId` 时直接拒绝登录。
>
> 合成邮箱的做法与飞书 SSO 预置服务商（`src/libs/better-auth/sso/providers/feishu.ts`）一致：
> `users.email` 可空但唯一，用确定性的合成地址可以避免唯一约束冲突，并保证同一个人每次登录落到同一账号。
> 该域名不收信、不可解析，且：
>
> - 每个登录方式有自己的子域（`<providerKey>.dingtalk.sso`），两个钉钉登录方式互不冲突；
> - `*.dingtalk.sso` 是**保留命名空间**，注册守卫（`registrationGuard`）会拒绝任何自助注册 /
>   magic-link / 邮箱验证码使用该域名，本地账号无法抢占某个 unionId 的合成邮箱。

### 账号绑定安全

`dingtalk` **不会**被放进 Better Auth 的 `accountLinking.trustedProviders`：钉钉不能证明邮箱已验证
（我们还常常自己合成邮箱），受信任的服务商会把身份**隐式挂到同邮箱的已有账号**上。因此钉钉登录
永远只会创建 / 复用它自己的账号，不会接管已存在的本地账号。

## 2. 钉钉开放平台侧

1. 打开 [钉钉开放平台](https://open-dev.dingtalk.com/) → **应用开发** → 创建 / 选择一个企业内部应用。

2. 进入 **登录与分享（第三方个人应用 / 企业内部应用登录）**，开启扫码登录。

3. **回调域名 / 重定向 URL** 需要登记**两条**地址（都能在向导里直接复制，`{providerKey}` 已自动替换成实际值）：

   ```text
   生产登录：      <APP_URL>/oauth/identity-provider/dingtalk/<providerKey>
   测试 / 添加企业：<APP_URL>/oauth/identity-provider/test/callback
   ```

   例如 `providerKey` 取 `dingtalk`、`APP_URL=https://ai.example.com` 时：

   ```text
   https://ai.example.com/oauth/identity-provider/dingtalk/dingtalk
   https://ai.example.com/oauth/identity-provider/test/callback
   ```

   > **为什么生产地址不是 `/api/auth/oauth2/callback/<providerKey>`？**
   > 钉钉统一登录回调时带的参数是 `authCode`，而不是 OAuth 2.0 标准的 `code`；Better Auth 的
   > 通用回调只认 `code`。因此钉钉登记的是上面那个转接地址：它把 `authCode` 改写成 `code` 后
   > 302 到 `/api/auth/oauth2/callback/<providerKey>`。同源跳转，浏览器会带上 Better Auth 签名
   > 的 state cookie，安全模型不变；只透传 OAuth 授权响应参数，其余一律丢弃。
   > 测试回调两种参数都接受，因此只需要一条。
   >
   > 平台向钉钉发起授权请求时带的 `redirect_uri` **就是**这个转接地址（不是 Better Auth 的回调），
   > 所以钉钉只需登记这一条即可；转接路由本身还会校验该 providerKey 确实是一个已生效的钉钉登录方式，
   > 未知或非钉钉的 key 一律 404。

   第二条地址与 providerKey 无关，全实例共用一条。

4. **权限管理**：开通 **通讯录个人信息读权限**（`Contact.User.Read`）与 **`corpid`**。
   可选：再开通 **企业信息读权限**（`Contact.Org.Read`），管理端「允许的企业」表格就能自动显示企业名称而不只是 `ding…` 编号（未开通时仍可正常添加，只是名称列显示“暂未获取到企业名称”，并提示需要开通的权限）。
   缺前者会在读取用户资料时被钉钉拒绝（403）；缺后者拿不到企业 ID，无法添加企业。

5. 在 **凭证与基础信息** 记下 **AppKey**（= Client ID）与 **AppSecret**（= Client Secret）。

> 无需记录 CorpId —— 企业 ID 由 "通过钉钉登录添加企业" 流程自动获取（见下）。

## 3. AIHub 管理后台侧

**管理后台 → 安全与认证 → 登录方式 → 新建 → 钉钉**，然后按向导四步走
（钉钉的 "发现" 与 "声明" 两步会自动隐藏 —— 端点与声明映射由协议固定）：

1. **基本**
   - 显示名称：例如 `钉钉`
   - 提供商标识（`providerKey`）：例如 `dingtalk`（小写字母 / 数字 /`.`/`-`/`_`，决定回调 URL 与合成邮箱子域）
   - 按钮文案：默认 `使用钉钉登录`
   - 图标：默认 `dingtalk`，登录页会渲染内置的钉钉图标；也可以填一个 `https://…` 图片地址
2. **客户端**
   - Client ID (AppKey) / Client Secret (AppSecret)：填第 2 步记下的值
   - 复制生产回调 URL（和测试回调 URL）回填到钉钉开放平台
   - **先保存一次**：后面的 "添加企业" 需要服务端已经存有 AppKey/AppSecret
3. **策略 → 允许的企业**（核心；本面板同时展示两条回调地址，可直接复制）
   - 点击「**通过钉钉登录添加企业**」→ 弹出钉钉登录窗口 → 用该企业的账号扫码 / 登录并授权
   - 授权成功后系统自动读取该企业的 CorpId 并加入允许列表，备注默认写成「由 <昵称> 添加」
   - 备注可改；重复添加同一个企业不会产生第二条；可以「移除」
   - **管理员不需要、也无法手动输入 CorpId**
   - 添加 / 移除后草稿变为 "未保存"，点保存生效
   - 需要允许多个企业时，重复点该按钮，用各企业的账号分别登录一次
4. **策略 → 其它**
   - 自动开号：首次登录是否自动建账号
   - 邮箱域名白名单：钉钉常常没有真实邮箱、会用合成的 `@…dingtalk.sso` 地址，**开启白名单会把这些用户挡在门外**；除非确认所有成员在钉钉里都绑定了企业邮箱，否则请留空
5. **发布**
   - 允许列表为空时**不能发布**（提示「请先添加至少一个允许的企业」）；运行时同样是 fail-closed，空列表等于谁都不能登录
   - 发布前需要一次有效的 "安全登录测试"；上一步的 "添加企业" 本身就是一次真实登录测试，因此常见顺序是：
     添加企业 → 保存（版本 +1）→ 在发布步再跑一次安全登录测试 → 发布
   - 发布后按提示**重启激活**（登录配置不是热更新）

发布并重启后，登录页会出现「使用钉钉登录」按钮。

### 给已上线的钉钉登录追加企业

编辑该登录方式 →（如为已发布状态，先改一下并保存，使其回到草稿）→ 策略 → 通过钉钉登录添加企业 →
保存 → 发布 → 重启激活。

## 4. 运行时行为

- 令牌交换成功后**立刻**校验企业：token 响应里的 `corpId` 必须在允许列表中。
  - 不在列表 → 拒绝登录；
  - 响应里没有 `corpId`（`corpid` scope 未授予）→ 拒绝登录；
  - 允许列表为空 → 拒绝所有人。
  - 该校验发生在读取用户资料、查找 / 创建账号**之前**，非允许企业的成员不会在库里留下任何痕迹。
- 「添加企业」用的测试流程**不做**允许列表校验 —— 它正是用来发现 CorpId 的入口；该流程不写任何用户 / 账号数据，只返回声明预览与捕获到的 CorpId / 昵称。

## 5. 上线冒烟测试与失败分类

用真实钉钉应用点一次「通过钉钉登录添加企业」即可覆盖整条链路（授权 → 令牌交换 → 用户资料 →
企业捕获）。失败时不再只有一句「对方拒绝了本次请求」：服务端把失败按**阶段**分类，并把钉钉自己
的错误码一起带回来（错误码是稳定的机器标识，不含密钥 / 授权码 / 令牌）。管理端在两处展示 ——
策略步「允许的企业」面板（同时列出两条回调地址，可直接复制）与发布步的测试结果区域。

| 阶段                             | 存库的 errorCode                                                                                                             | 管理员看到的内容（原因 + **具体要开什么** + 钉钉错误码）                                                                                                               | 去哪一页改                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 授权页没回来                     | `OIDC_TEST_AUTHORIZATION_FAILED` / 最终超时                                                                                  | 「登录在对方页面上被取消或拒绝」/「测试超时」                                                                                                                          | 回调地址没登记（钉钉会先在自己的页面报 `redirect_uri` 不匹配），或用户点了取消 |
| 令牌交换被拒（凭据错）           | `OIDC_TEST_DINGTALK_TOKEN_REJECTED:invalidParameter.idOrSecret.notFound`                                                     | 「钉钉拒绝了凭据交换…」+ **「AppKey 或 AppSecret 填写有误。请到 钉钉开放平台 → 应用 → 凭证与基础信息 中重新复制这两个值。」** + 钉钉错误码                             | 应用 → 凭证与基础信息                                                          |
| 令牌交换被拒（其它）             | `OIDC_TEST_DINGTALK_TOKEN_REJECTED[:<码>]`                                                                                   | 「钉钉拒绝了凭据交换。请检查 AppSecret，并确认下方显示的回调地址已按原样登记…」+ 钉钉错误码                                                                            | 多半是回调地址与登记的不一致                                                   |
| 读资料被拒（403 / 权限）         | `OIDC_TEST_DINGTALK_PROFILE_FORBIDDEN[:<码>]`，或 `..._PROFILE_REJECTED` 带 `Forbidden.AccessDenied*` / 含 `Permission` 的码 | 「钉钉拒绝返回用户资料…」+ **「未开通权限：通讯录个人信息读权限（Contact.User.Read）。请到 钉钉开放平台 → 应用 → 权限管理 中搜索并开通，然后重试。」** + 钉钉错误码    | 应用 → 权限管理                                                                |
| 读资料其它失败                   | `OIDC_TEST_DINGTALK_PROFILE_REJECTED[:<码>]`                                                                                 | 「账号已登录，但钉钉没有返回可用的用户资料」+ 钉钉错误码                                                                                                               | 检查通讯录相关权限                                                             |
| 没有企业 ID                      | `OIDC_TEST_CORP_ID_MISSING`                                                                                                  | 「钉钉没有返回企业信息…」+ **「缺少授权范围：`corpid`。请到 钉钉开放平台 → 应用 → 登录与分享 → 授权范围（scopes）中加上 `corpid`，然后重试。」**                       | 应用 → 登录与分享 → 授权范围                                                   |
| 资料缺必需字段（首先是 unionId） | `OIDC_TEST_CLAIM_VALIDATION_FAILED`                                                                                          | 「账号已通过认证，但返回的资料缺少必需信息…」+ **「请确认『登录与分享 → 授权范围』包含 `openid`，且『权限管理』中已开通通讯录个人信息读权限（Contact.User.Read）。」** | 登录与分享 + 权限管理；若开了邮箱域名白名单也要清空                            |
| 测试链接被重复使用               | `OIDC_TEST_REPLAYED`                                                                                                         | 「该测试链接已被使用，请重新发起测试。」                                                                                                                               | 重新发起                                                                       |
| 其它 / 未知                      | 原样保留                                                                                                                     | 通用提示 + 原始钉钉错误码                                                                                                                                              | 按错误码判断                                                                   |

**加粗**部分是精确整改指引：管理端直接写出要开通的权限 / 授权范围的**中文名与英文标识**（英文标识
就是钉钉控制台搜索框能匹配的那个），以及在哪一页开。未知错误码不编造整改建议 —— 只给通用提示
加原始错误码。

服务端同时打一行脱敏日志：
`[identityProviderTest] DingTalk rejected the request { dingtalkCode, stage, status }` ——
只有这三个有界字段，永远不含 AppSecret、授权码或访问令牌。

> 一次只允许有一个进行中的钉钉登录：进行中时「通过钉钉登录添加企业」按钮会禁用并说明原因，
> 避免第二次点击把第一次的结果丢掉。允许列表达到 200 条上限时同样禁用并提示。

### `http://localhost` 能不能用作回调地址？

钉钉校验的是回调地址是否与登记的**完全一致**。`localhost` 只是一个普通主机名：只要在应用的
「登录与分享」里把 `http://localhost:3010/...` 两条地址原样登记上，本机联调就能通过 —— 授权发生
在管理员自己的浏览器里，钉钉只做 302 跳转，不需要从公网访问你的实例。两点注意：

- 必须**原样**登记，含 `http://` 与端口号；协议、主机、端口任一不同都会被拒。
- `APP_URL` 必须同样是 `http://localhost:3010`，否则平台生成的回调地址与登记的对不上。

若贵司的钉钉应用类型不允许登记非 HTTPS 地址，请改用一个能解析到该实例的 HTTPS 域名，并把
`APP_URL` 一并改成该地址。

## 6. 数据落点与实现说明

- 回滚会连同允许列表一起还原到目标版本（不会保留当前草稿的授权）。
- 允许列表存在 `platform_identity_providers.dingtalk_allowed_corps`（jsonb，迁移
  `packages/database/migrations/0015_identity_provider_dingtalk_allowed_corps.sql`，幂等）。
  CHECK 限定：数组、≤200 条、≤64KB、`corpId` 匹配 `^[A-Za-z0-9_-]{1,64}$`，且只有 `dingtalk`
  kind 允许有条目（改 kind 不会留下悬空授权）。
- `use_pkce` 在库里仍为 `TRUE`（该列有平台级 `CHECK (use_pkce)`），运行时适配器对 `dingtalk` 关闭 PKCE —— 钉钉未实现 RFC 7636。OAuth `state` 校验不受影响，仍然强制且一次性。
- 启动时不做网络发现：`enrichRuntimeProviders` 对 `dingtalk` 使用静态端点，钉钉不可达不会拖慢或降级实例启动。
- 钉钉不支持 `prompt=login` / `max_age`，因此**管理端二次认证**在钉钉上退化为一次显式的重新授权点击，而不是强制重新认证。需要严格二次认证的管理员，请用本地 Break-glass 账号或 Authentik。
- kind 放宽迁移：`packages/database/migrations/0013_identity_provider_dingtalk_kind.sql`。
- 回调转接：`src/enterprise/server/dingtalkLoginCallback.ts` +
  `src/app/(backend)/oauth/identity-provider/dingtalk/[providerKey]/route.ts`；该路径在
  `isPublicRoute` 中单独放行（登录回调发生在用户尚无会话时），`/oauth/identity-provider/test/*`
  仍然需要登录态。
- 保存草稿、开始测试、添加企业**不再要求填写原因**（服务端 `reason` 改为可选，审计记 `—`）；
  发布 / 停用 / 回滚 / 删除仍然要求原因并需要二次认证。
