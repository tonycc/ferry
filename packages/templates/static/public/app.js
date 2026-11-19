// 访问者是谁:由 Ferry 的登录网关确认,页面通过 /whoami 读取
fetch("/whoami")
  .then((res) => res.json())
  .then((who) => {
    if (who) document.getElementById("greeting").textContent = `你好,${who.name}`;
  });
