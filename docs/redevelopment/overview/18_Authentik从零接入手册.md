# Authentik 从零接入手册(超管 UI 操作)

> 2026-07-23 制定。适用场景:全新 AIHub 实例从零对接 Authentik 钉钉登录。
> 本手册所有步骤均可由超级管理员在 **Authentik 管理 UI** 与 **AIHub 管理面板 UI** 完成,无需手写配置文件。
> EasyAuth 授权模块已于同日移除(main `e30e5938` 起):Authentik 登录成功即视为准入,首登自动获得 `platform_user` 角色;管理员角色在 AIHub 管理面板"用户/权限管理"授予。

## 0. 前提

- Authentik 为定制镜像 `authentik-dingtalk:local`(内置钉钉 OAuth 源类型、目录同步与允入名单能力;源码 `/Users/konata/code/Authentik`,部署 `~/.local/share/easyauth/authentik/`)。
- Authentik 中的**钉钉源实例**(slug `dingtalk`)已存在并正常运作(全公司共用,一般不需重建;如需从零建源:管理界面 → 目录 → 联邦与社交登录 → 创建 → DingTalk,填钉钉应用 AppKey/AppSecret)。
- 钉钉用户资料存于 Authentik 用户的 `attributes["dingtalk"]`(含 `name`/`avatar`/`title`/`user_id` 等),由钉钉源在登录与目录同步时写入。

## 1. Authentik 侧(auth.jiefakj.com,超管登录管理界面)

### 1.1 新建两个 Scope 属性映射

路径:**自定义 → 属性映射 → 创建 → Scope 映射**

**① AIHub DingTalk profile claims**(Scope 名称:`dingtalk`)

```python
dingtalk = request.user.attributes.get("dingtalk", {}) or {}

claims = {
    "name": dingtalk.get("name") or dingtalk.get("nick") or request.user.name,
    "picture": dingtalk.get("avatar"),
    "dingtalk_title": dingtalk.get("title"),
    "dingtalk_user_id": dingtalk.get("user_id"),
    "dingtalk_union_id": dingtalk.get("union_id"),
}

return {k: v for k, v in claims.items() if v not in (None, "", [], {})}
```

> 姓名/头像/职位即来自这里:`name`(钉钉真名)、`picture`(钉钉头像 URL)、`dingtalk_title`(职位)。
> 不要复用 EasyAuth 的同名 scope 映射(那份不含姓名/头像/职位);也绝不映射 `dingtalk.raw_profile`。

**② AIHub email with DingTalk fallback**(Scope 名称:`email`)

```python
email = request.user.email
if not email:
    dingtalk = request.user.attributes.get("dingtalk", {}) or {}
    uid = dingtalk.get("user_id") or request.user.username
    email = f"{uid}@dingtalk.jiefakj.com"
return {"email": email, "email_verified": True}
```

> 钉钉通讯录用户普遍无邮箱,而 AIHub 建号必须有 email;该域不收信,仅作稳定标识。

### 1.2 新建 OAuth2/OIDC Provider

路径:**应用程序 → 提供程序 → 创建 → OAuth2/OpenID Provider**

| 配置项 | 值 |
|---|---|
| 名称 | `AIHub OIDC` |
| 授权流程 | `default-provider-authorization-implicit-consent` |
| 客户端类型 | 机密(confidential) |
| Client ID | `aihub` |
| Client Secret | 保留生成值,**立即抄录**(存 `~/.local/share/aihub/secrets/authentik-aihub-client-secret.txt`,600 权限) |
| **授权类型(grant types)** | **必须勾选 `authorization_code` + `refresh_token`**。本 fork 新增字段,默认为空=拒绝所有授权请求,漏配的症状是登录跳回 `error=invalid_request`("The request is otherwise malformed") |
| 重定向 URI(严格) | `http://localhost:3010/api/auth/oauth2/callback/authentik`<br>`http://localhost:3010/oauth/identity-provider/test/callback`<br>`https://aihub.jiefakj.com/api/auth/oauth2/callback/authentik`<br>`https://aihub.jiefakj.com/oauth/identity-provider/test/callback` |
| 签名密钥 | 选现有证书(与 easytrade Provider 同一把即可) |
| Scope 映射 | 勾选:默认 `openid`、默认 `profile`、**AIHub email with DingTalk fallback**(勿选默认 email)、**AIHub DingTalk profile claims** |
| 主题模式(sub) | 基于用户 UUID(`user_uuid`) |
| 在 ID Token 中包含 claims | 开 |

### 1.3 新建 Application

路径:**应用程序 → 应用程序 → 创建**:名称 `AIHub`,Slug `aihub`,提供程序选 `AIHub OIDC`。

完成后验证 Discovery:`https://auth.jiefakj.com/application/o/aihub/.well-known/openid-configuration` 返回 200,issuer 为 `https://auth.jiefakj.com/application/o/aihub/`。

> 2026-07-23 从零重建实录:旧 Provider(pk=4)与 Application 已删除,按上述步骤重建为 Provider pk=6,新 client secret 已换存。

## 2. AIHub 侧(http://localhost:3010/admin,本地超管登录)

1. **安全与认证 → 登录与权限 → 新建身份提供方**,类型选 **Authentik**(模板自带 `dingtalk` scope 与 claim 映射:`picture→头像`、`dingtalk_title→职位`、`dingtalk_user_id`,一般无需改):
   - Issuer:`https://auth.jiefakj.com/application/o/aihub/`
   - Client ID:`aihub`;Client Secret:1.2 抄录值
   - 按钮文案:`使用工作账号登录`;自动建号(JIT):开
2. **安全登录测试**:点"测试登录",用 Authentik 账号完成一次回调(发布的硬前置:同 revision + 同 secret 指纹必须有成功测试)。
3. **发布** → **重启并激活**(`PLATFORM_OIDC_RESTART_MODE=supervisor` 下按钮全链路可用;等旧实例心跳过期约 90 秒收敛)。
4. 登录页出现「使用工作账号登录」即生效。

## 3. 验证清单

- [ ] 钉钉扫码(或 Authentik 本地测试账号)登录成功,首登自动建号;
- [ ] `users` 表:`full_name`=钉钉姓名、`avatar`=钉钉头像 URL、`dingtalk_title`=职位、`dingtalk_user_id` 落库;
- [ ] 管理面板 → 用户:列表「职位」列与详情概览显示职位(空显示 —);
- [ ] 二次登录:在钉钉/Authentik 改头像或职位后重新登录,本地资料被刷新(better-auth `overrideUserInfo`);
- [ ] 新用户默认角色为 `platform_user`,管理员在管理面板授予 admin 角色包。

## 4. 故障兜底(break-glass)

- 本地管理员 `admin@aihub.local`(credential 登录)保留,用于 Authentik 故障时进入面板;密码在 `~/.local/share/aihub/secrets/demo-admin-password.txt`。
- env 直配路径(`AUTH_SSO_PROVIDERKEYS`/`AUTH_AUTHENTIK_*`)平时必须置空 `AUTH_SSO_PROVIDERS=`,防止遮蔽 DB 提供方(`environment_provider_shadowed`);仅在数据库 OIDC 整体不可用时临时启用。
