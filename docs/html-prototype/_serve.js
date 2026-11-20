// 原型预览用极简静态服务器（零依赖）
const http = require("http"), fs = require("fs"), path = require("path");
const root = __dirname;
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  const f = path.join(root, path.normalize(p).replace(/^([.][.][\/\\])+/, ""));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": mime[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(d);
  });
}).listen(8765, "127.0.0.1", () => console.log("serving " + root + " @ http://127.0.0.1:8765/"));
