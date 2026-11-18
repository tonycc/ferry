import { useEffect, useState } from "react";

interface AppView {
  name: string;
  url: string;
  visibility: "self" | "department" | "company";
  live: boolean;
  disabled: boolean;
}

const VISIBILITY_LABEL: Record<AppView["visibility"], string> = {
  self: "仅自己",
  department: "本部门",
  company: "全公司",
};

// TODO: 接入登录(任务 2.2)后删除。开发阶段 publisher 从这个请求头读取用户 ID,部门从组织架构查
const DEV_HEADERS = { "x-ferry-user": "dingtalk:alice" };

export function App() {
  const [apps, setApps] = useState<AppView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/apps", { headers: DEV_HEADERS })
      .then(async (res) => {
        if (!res.ok) throw new Error(`请求失败 (${res.status})`);
        setApps((await res.json()) as AppView[]);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  return (
    <main style={{ maxWidth: 720, margin: "48px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1>我的应用</h1>
      {error && <p role="alert">加载失败: {error}</p>}
      {!error && apps === null && <p>加载中…</p>}
      {apps?.length === 0 && <p>还没有应用。在 agent 里做好应用并确认发布后,它会出现在这里。</p>}
      {apps && apps.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
          <thead>
            <tr>
              <th>名称</th>
              <th>访问地址</th>
              <th>可见范围</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <tr key={app.name}>
                <td>{app.name}</td>
                <td>{app.live && !app.disabled ? <a href={app.url}>{app.url}</a> : app.url}</td>
                <td>{VISIBILITY_LABEL[app.visibility]}</td>
                <td>{app.disabled ? "已被管理员停用" : app.live ? "已上线" : "未发布"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
