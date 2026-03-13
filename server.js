const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DOWNLOADS = path.join(__dirname, "downloads");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
};

function getBooks() {
  if (!fs.existsSync(DOWNLOADS)) return [];
  const folders = fs.readdirSync(DOWNLOADS).filter((f) => {
    const p = path.join(DOWNLOADS, f);
    return fs.statSync(p).isDirectory();
  });

  const books = [];
  for (const folder of folders) {
    const bookDir = path.join(DOWNLOADS, folder, "book");
    if (!fs.existsSync(bookDir)) continue;

    const plBook = path.join(bookDir, "book-pl.html");
    const enBook = path.join(bookDir, "book-en.html");
    const hasPL = fs.existsSync(plBook);
    const hasEN = fs.existsSync(enBook);
    if (!hasPL && !hasEN) continue;

    // Try to get title from the book HTML
    let title = folder;
    try {
      const htmlFile = hasPL ? plBook : enBook;
      const html = fs.readFileSync(htmlFile, "utf8");
      const m = html.match(/<title>([^<]+)<\/title>/);
      if (m) title = m[1];
    } catch { /* use folder name */ }

    // Get a cover frame
    let coverFrame = null;
    try {
      const files = fs.readdirSync(bookDir).filter((f) => f.endsWith(".png")).sort();
      if (files.length > 0) coverFrame = `/${folder}/book/${files[0]}`;
    } catch { /* no cover */ }

    books.push({ folder, title, hasPL, hasEN, coverFrame });
  }

  return books;
}

function renderIndex() {
  const books = getBooks();

  const bookCards = books.length === 0
    ? `<p class="empty">Brak przetworzonych bajek. Uruchom <code>node index.js "URL"</code> aby stworzyć pierwszą książeczkę.</p>`
    : books.map((b) => {
        const cover = b.coverFrame
          ? `<img src="${b.coverFrame}" alt="cover">`
          : `<div class="no-cover">📖</div>`;
        const links = [
          b.hasPL ? `<a href="/${b.folder}/book/book-pl.html" class="btn btn-pl">🇵🇱 Polski</a>` : "",
          b.hasEN ? `<a href="/${b.folder}/book/book-en.html" class="btn btn-en">🇬🇧 English</a>` : "",
        ].filter(Boolean).join("\n");

        return `
      <div class="card">
        <div class="card-cover">${cover}</div>
        <div class="card-body">
          <h2>${escapeHtml(b.title)}</h2>
          <div class="links">${links}</div>
        </div>
      </div>`;
      }).join("\n");

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LinkToTale — Twoje książeczki</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Nunito', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #fff;
      padding: 40px 20px 60px;
    }
    header {
      text-align: center;
      margin-bottom: 48px;
    }
    header h1 {
      font-size: clamp(28px, 5vw, 48px);
      font-weight: 800;
      background: linear-gradient(135deg, #667eea, #f093fb);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    header p {
      margin-top: 8px;
      font-size: 18px;
      color: rgba(255,255,255,0.6);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 28px;
      max-width: 1100px;
      margin: 0 auto;
    }
    .card {
      background: rgba(255,255,255,0.08);
      border-radius: 20px;
      overflow: hidden;
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      transition: transform 0.25s, box-shadow 0.25s;
    }
    .card:hover {
      transform: translateY(-4px);
      box-shadow: 0 12px 40px rgba(0,0,0,0.3);
    }
    .card-cover {
      height: 200px;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0,0,0,0.2);
    }
    .card-cover img {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }
    .no-cover {
      font-size: 64px;
    }
    .card-body {
      padding: 20px 24px 24px;
    }
    .card-body h2 {
      font-size: 20px;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 16px;
    }
    .links {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 10px 22px;
      border-radius: 50px;
      font-size: 15px;
      font-weight: 700;
      text-decoration: none;
      transition: transform 0.15s, box-shadow 0.15s;
    }
    .btn:hover { transform: scale(1.05); box-shadow: 0 4px 16px rgba(0,0,0,0.3); }
    .btn-pl {
      background: linear-gradient(135deg, #667eea, #764ba2);
      color: #fff;
    }
    .btn-en {
      background: linear-gradient(135deg, #f093fb, #f5576c);
      color: #fff;
    }
    .empty {
      text-align: center;
      color: rgba(255,255,255,0.5);
      font-size: 18px;
      grid-column: 1 / -1;
    }
    .empty code {
      background: rgba(255,255,255,0.1);
      padding: 2px 8px;
      border-radius: 6px;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <header>
    <h1>📚 LinkToTale</h1>
    <p>Twoje książeczki obrazkowe</p>
  </header>
  <div class="grid">
    ${bookCards}
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function serveFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // Landing page
  if (pathname === "/" || pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderIndex());
    return;
  }

  // Serve files from downloads/<folder>/book/
  // Path must match: /<folder>/book/<file>
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 3 && parts[1] === "book") {
    const folder = parts[0];
    const rest = parts.slice(1).join("/");
    const filePath = path.join(DOWNLOADS, folder, rest);

    // Security: ensure resolved path stays inside downloads
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(DOWNLOADS))) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    serveFile(res, resolved);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not found");
});

server.listen(PORT, () => {
  console.log(`\n📚 LinkToTale server running at:\n`);
  console.log(`   http://localhost:${PORT}\n`);

  const books = getBooks();
  if (books.length > 0) {
    console.log(`   Found ${books.length} book(s):\n`);
    for (const b of books) {
      console.log(`   • ${b.title}`);
      if (b.hasPL) console.log(`     🇵🇱  http://localhost:${PORT}/${b.folder}/book/book-pl.html`);
      if (b.hasEN) console.log(`     🇬🇧  http://localhost:${PORT}/${b.folder}/book/book-en.html`);
      console.log();
    }
  } else {
    console.log(`   No books yet. Run: node index.js "YOUTUBE_URL"\n`);
  }
});
