# LinkToTale

**Paste a YouTube link. Get a picture book you can read with your child.**

Instead of watching a screen, sit together and read the story — page by page, with real illustrations from the cartoon, in Polish and English.

## What it does

Paste a YouTube link to a children's cartoon. It downloads the video, extracts frames, reads subtitles, analyzes scenes with AI, and generates an interactive HTML picture book — in Polish and English.

```
YouTube link → frames + subtitles + AI → interactive picture book (PL + EN)
```

The child sees familiar characters and scenes from a cartoon they love, but instead of passively watching — you read together.

## Quick start

```bash
git clone https://github.com/RafalMCichon/linktotale.git
cd linktotale
npm install
echo "OPENAI_API_KEY=your_key_here" > .env
```

```bash
node index.js "https://www.youtube.com/watch?v=EXAMPLE"
```

Open `downloads/book/book-pl.html` in a browser. That's your picture book.

## Requirements

- Node.js 18+
- macOS with Homebrew (auto-installs `yt-dlp` and `ffmpeg`)
- OpenAI API key ([platform.openai.com](https://platform.openai.com))

## How it works

1. Downloads video and subtitles (PL + EN) via `yt-dlp`
2. Extracts frames at 1 FPS via `ffmpeg`
3. Detects scene changes by comparing frames visually
4. Analyzes key scenes without dialogue using GPT-4.1-mini Vision
5. Builds a chronological timeline with dialogue + scene descriptions
6. GPT-4.1 generates a children's story (25-35 pages) faithful to the original plot
7. GPT-4.1-mini Vision verifies each page has the right illustration
8. Outputs two interactive HTML books (Polish + English) with swipe/keyboard navigation

## Commands

| Command | What it does |
|---------|-------------|
| `node index.js "URL"` | Full pipeline — download + generate picture book |
| `node index.js --book` | Regenerate book from already-downloaded content |

## Output

```
downloads/
  book/
    book-pl.html          ← Polish picture book
    book-en.html          ← English picture book
  frames/                 ← Raw frames (1 FPS)
  frames-with-subtitles-pl/  ← Frames with Polish subtitles
  frames-with-subtitles-en/  ← Frames with English subtitles
  frames-analysis/        ← AI scene descriptions
  subtitles/              ← SRT files
```

## Cost

A single cartoon (~12 min) costs approximately:
- ~$0.15 for frame analysis (GPT-4.1-mini Vision)
- ~$0.30 for story generation (GPT-4.1)
- ~$0.06 for frame verification (GPT-4.1-mini Vision)
- **~$0.50 total**

## Disclaimer

This tool is intended for **personal, non-commercial use** — parents reading with their own children. It does not host, distribute, or store any copyrighted content. Users are solely responsible for ensuring their use complies with applicable copyright laws and the terms of service of content platforms. The authors assume no liability for how this tool is used.

## License

MIT
