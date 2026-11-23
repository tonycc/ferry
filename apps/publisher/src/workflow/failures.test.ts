import { describe, expect, it } from "vitest";
import { manifestSchema } from "@ferry/manifest";
import { scanFailure } from "./failures";

const manifest = manifestSchema.parse({ name: "expense", template: "node-postgres" });
const thirdParty = [{ file: "src/a.ts", line: 3, rule: "dingtalk-robot-webhook", detail: "钉钉群机器人 webhook" }];

describe("scanFailure", () => {
  it("第三方密钥的提示里给出控制台密钥页的完整地址(agent 不知道控制台在哪)", () => {
    const { hint } = scanFailure(thirdParty, manifest, "https://ferry.corp.example/console");
    expect(hint).toContain("https://ferry.corp.example/console/apps/expense#secrets");
  });

  it("不知道控制台地址时退回到说明怎么拼", () => {
    const { hint } = scanFailure(thirdParty, manifest);
    expect(hint).toContain("Ferry 地址加 /console/apps/expense#secrets");
  });
});
