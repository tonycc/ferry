# 测试用证书

只给 `certificate.test.ts` 用的自签名证书,和任何真实域名无关。根证书和中间证书的私钥生成后就删了。

| 文件 | 内容 |
|---|---|
| `root.pem` | 测试根证书(测试里当作受信任的根) |
| `inter.pem` | 由根证书签发的中间证书 |
| `leaf.pem`、`leaf.key` | 由中间证书签发,覆盖 `ferry.example.com` 和 `*.apps.example.com`,2036 年到期 |
| `leaf-ferry-only.pem` | 同一把私钥,只覆盖 `ferry.example.com` |
| `chain.pem`、`chain-ferry-only.pem` | 叶子证书 + 中间证书 |
| `other.key` | 和上面证书都不匹配的私钥 |
