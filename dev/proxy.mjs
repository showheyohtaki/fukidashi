// 開発用の中継。拡張の「接続先」を http://127.0.0.1:8787 にすると、APIキーをブラウザに保存せずに試せる。
// キーはこのプロセスの環境変数 OPENAI_API_KEY からだけ読む（with-env-keys.sh 経由で起動する）。
import http from "node:http";
import tls from "node:tls";

const KEY = process.env.OPENAI_API_KEY;
const PORT = Number(process.env.PORT || 8787);
if (!KEY) {
  console.error("OPENAI_API_KEY がありません");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors());
    return res.end();
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = { ...req.headers, host: "api.openai.com", authorization: `Bearer ${KEY}` };
  delete headers["content-length"];
  delete headers.origin;
  delete headers.referer;
  delete headers["accept-encoding"]; // 圧縮を解いた中身をそのまま流すため
  try {
    const r = await fetch("https://api.openai.com" + req.url, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    // 流れてくる応答（ストリーミング）は、届いた分からそのまま返す
    res.writeHead(r.status, { ...cors(), "content-type": r.headers.get("content-type") || "application/octet-stream" });
    if (r.body) for await (const chunk of r.body) res.write(chunk);
    res.end();
    console.log(`${req.method} ${req.url.split("?")[0]} -> ${r.status}`);
  } catch (e) {
    res.writeHead(502, cors());
    res.end(String(e));
  }
});

server.on("upgrade", (req, socket, head) => {
  const up = tls.connect(443, "api.openai.com", { servername: "api.openai.com" }, () => {
    const lines = [
      `GET ${req.url} HTTP/1.1`,
      "Host: api.openai.com",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"]}`,
      "Sec-WebSocket-Version: 13",
      "Sec-WebSocket-Protocol: realtime",
      `Authorization: Bearer ${KEY}`,
      "",
      "",
    ];
    up.write(lines.join("\r\n"));
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
    console.log(`WS ${req.url}`);
  });
  const close = () => { socket.destroy(); up.destroy(); };
  up.on("error", close);
  socket.on("error", close);
  up.on("close", close);
  socket.on("close", close);
});

function cors() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
}

server.listen(PORT, "127.0.0.1", () => console.log(`proxy http://127.0.0.1:${PORT}`));
