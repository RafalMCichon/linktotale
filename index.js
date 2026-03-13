require("dotenv").config();
const { exec: execCb } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");

const exec = promisify(execCb);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── Progress Logger ─────────────────────────────────────────
let _stepNum = 0;
function step(msg) {
  _stepNum++;
  const line = `\n[${ ''}${_stepNum}] ${msg}`;
  console.log(`\x1b[36m${line}\x1b[0m`);
  console.log('─'.repeat(50));
}
function sub(msg) { console.log(`   → ${msg}`); }
function done(msg) { console.log(`   ✓ ${msg}`); }
function warn(msg) { console.log(`   ⚠ ${msg}`); }

// ─── Directories (will be set per video) ────────────────────
let DOWNLOADS_DIR;
let FRAMES_DIR;
let FRAMES_WITH_SUBTITLES_PL_DIR;
let FRAMES_WITH_SUBTITLES_EN_DIR;
let SUBTITLES_DIR;
let ANALYSIS_DIR;
let BOOK_DIR;

function initDirectories(videoId) {
  DOWNLOADS_DIR = path.join(__dirname, "downloads", videoId);
  FRAMES_DIR = path.join(DOWNLOADS_DIR, "frames");
  FRAMES_WITH_SUBTITLES_PL_DIR = path.join(DOWNLOADS_DIR, "frames-with-subtitles-pl");
  FRAMES_WITH_SUBTITLES_EN_DIR = path.join(DOWNLOADS_DIR, "frames-with-subtitles-en");
  SUBTITLES_DIR = path.join(DOWNLOADS_DIR, "subtitles");
  ANALYSIS_DIR = path.join(DOWNLOADS_DIR, "frames-analysis");
  BOOK_DIR = path.join(DOWNLOADS_DIR, "book");

  [DOWNLOADS_DIR, FRAMES_DIR, FRAMES_WITH_SUBTITLES_PL_DIR,
   FRAMES_WITH_SUBTITLES_EN_DIR, SUBTITLES_DIR, ANALYSIS_DIR,
   BOOK_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

function extractVideoId(url) {
  // Extract YouTube video ID from various URL formats
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  // Fallback: use sanitized URL as folder name
  return url.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
}

// ─── Correct SRT Parser ─────────────────────────────────────
function parseSRT(content) {
  const blocks = content.trim().split(/\n\s*\n/);
  const subtitles = [];
  for (const block of blocks) {
    const lines = block.trim().split("\n");
    const tsLine = lines.find((l) => l.includes(" --> "));
    if (!tsLine) continue;
    const m = tsLine.match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3}) --> (\d{2}:\d{2}:\d{2}[.,]\d{3})/
    );
    if (!m) continue;
    const textLines = lines.slice(lines.indexOf(tsLine) + 1);
    const text = textLines.join(" ").trim();
    if (!text) continue;
    subtitles.push({
      startSec: tsToSec(m[1]),
      endSec: tsToSec(m[2]),
      startFrame: Math.floor(tsToSec(m[1])),
      endFrame: Math.ceil(tsToSec(m[2])),
      text,
    });
  }
  return subtitles;
}

function tsToSec(ts) {
  const [h, m, rest] = ts.split(":");
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseFloat(rest.replace(",", "."));
}

function convertVTTtoSRT(vttPath, srtPath) {
  if (!fs.existsSync(vttPath)) return false;
  
  const vttContent = fs.readFileSync(vttPath, "utf8");
  const lines = vttContent.split("\n");
  const srtLines = [];
  let counter = 1;
  let i = 0;
  
  // Skip VTT header
  while (i < lines.length && !lines[i].includes("-->")) {
    i++;
  }
  
  while (i < lines.length) {
    const line = lines[i].trim();
    
    if (line.includes("-->")) {
      // Convert timestamp format from VTT to SRT
      const timestamp = line.replace(/\./g, ",");
      i++;
      
      // Collect subtitle text
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].includes("-->")) {
        const text = lines[i].trim();
        // Remove VTT tags like <c> </c>
        const cleanText = text.replace(/<[^>]+>/g, "");
        if (cleanText) textLines.push(cleanText);
        i++;
      }
      
      if (textLines.length > 0) {
        srtLines.push(counter.toString());
        srtLines.push(timestamp);
        srtLines.push(textLines.join("\n"));
        srtLines.push(""); // Empty line between subtitles
        counter++;
      }
    } else {
      i++;
    }
  }
  
  fs.writeFileSync(srtPath, srtLines.join("\n"), "utf8");
  return true;
}

// ─── Download & Extract ──────────────────────────────────────
async function installDeps() {
  try {
    await exec("which yt-dlp && which ffmpeg");
  } catch {
    try {
      sub('Installing yt-dlp and ffmpeg via Homebrew...');
      await exec("brew install yt-dlp ffmpeg");
    } catch {
      warn("Could not install yt-dlp/ffmpeg via brew. Make sure they are installed.");
    }
  }
}

async function downloadVideo(url, outputTemplate) {
  // Check if cookies.json exists, otherwise use browser cookies
  const cookiesPath = path.join(__dirname, "cookies.json");
  const cookiesArg = fs.existsSync(cookiesPath) 
    ? `--cookies "${cookiesPath}"` 
    : "--cookies-from-browser chrome";
  
  // Try with subtitles first, if fails try without
  const cmdWithSubs = `yt-dlp -f "bv*+ba/best" --write-sub --write-auto-sub --sub-lang pl,en --convert-subs srt --sleep-requests 1 --sleep-subtitles 2 ${cookiesArg} -o "${outputTemplate}" "${url}"`;
  const cmdNoSubs = `yt-dlp -f "bv*+ba/best" ${cookiesArg} -o "${outputTemplate}" "${url}"`;
  
  console.log("Starting download...");
  try {
    await exec(cmdWithSubs, { maxBuffer: 100 * 1024 * 1024 });
    done('Download complete (video + subtitles)');
  } catch (e) {
    if (e.message.includes("429") || e.message.includes("Too Many Requests") || e.message.includes("Unable to download video subtitles")) {
      warn("Subtitle download failed (rate limit). Downloading video only...");
      try {
        await exec(cmdNoSubs, { maxBuffer: 100 * 1024 * 1024 });
        done('Video downloaded (subtitles unavailable — Whisper will be used)');
        return;
      } catch (retryError) {
        console.error("Video download failed:", retryError.message);
        process.exit(1);
      }
    }
    
    console.error("Download failed:", e.message);
    if (e.message.includes("Sign in to confirm")) {
      console.error("\n⚠️  YouTube requires authentication.");
      console.error("Solutions:");
      console.error("1. Make sure you're logged into YouTube in Chrome");
      console.error("2. Or export cookies from your browser to cookies.json");
    }
    process.exit(1);
  }
}

async function getVideoFilename(url, outputTemplate) {
  const cookiesPath = path.join(__dirname, "cookies.json");
  const cookiesArg = fs.existsSync(cookiesPath) 
    ? `--cookies "${cookiesPath}"` 
    : "--cookies-from-browser chrome";
  const cmd = `yt-dlp --get-filename ${cookiesArg} -o "${outputTemplate}.%(ext)s" "${url}"`;
  const { stdout } = await exec(cmd);
  return stdout.trim();
}

async function getVideoTitle(url) {
  try {
    const cookiesPath = path.join(__dirname, "cookies.json");
    const cookiesArg = fs.existsSync(cookiesPath) 
      ? `--cookies "${cookiesPath}"` 
      : "--cookies-from-browser chrome";
    const { stdout } = await exec(`yt-dlp --get-title ${cookiesArg} "${url}"`);
    return stdout.trim() || "Unknown";
  } catch {
    return "Unknown";
  }
}

function getCartoonTitleFromDownloads() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return "Unknown";
  const files = fs.readdirSync(DOWNLOADS_DIR);
  const videoOrSrt = files.find((f) =>
    /\.(mp4|mkv|webm|avi|mov|srt)$/i.test(f)
  );
  if (!videoOrSrt) return "Unknown";
  return path.basename(videoOrSrt, path.extname(videoOrSrt));
}

function findExistingVideoFolder() {
  const downloadsRoot = path.join(__dirname, "downloads");
  if (!fs.existsSync(downloadsRoot)) return null;
  
  const folders = fs.readdirSync(downloadsRoot).filter(f => {
    const fullPath = path.join(downloadsRoot, f);
    return fs.statSync(fullPath).isDirectory();
  });
  
  if (folders.length === 0) return null;
  
  // Return the most recently modified folder
  const sorted = folders
    .map(f => ({
      name: f,
      path: path.join(downloadsRoot, f),
      mtime: fs.statSync(path.join(downloadsRoot, f)).mtime
    }))
    .sort((a, b) => b.mtime - a.mtime);
  
  return sorted[0].name;
}

async function extractFrames(videoPath) {
  const existing = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith(".png"));
  if (existing.length > 0) {
    done(`Frames already extracted (${existing.length} files). Skipping.`);
    return;
  }
  
  // Find the actual video file if videoPath doesn't exist
  let actualVideoPath = videoPath;
  if (!fs.existsSync(videoPath)) {
    console.log(`Looking for video in ${DOWNLOADS_DIR}...`);
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const videoFile = files.find((f) => 
      /\.(mp4|mkv|webm|avi|mov|m4a)$/i.test(f) || 
      (!f.includes('.') && fs.statSync(path.join(DOWNLOADS_DIR, f)).isFile())
    );
    if (videoFile) {
      actualVideoPath = path.join(DOWNLOADS_DIR, videoFile);
      sub(`Found video: ${videoFile}`);
    } else {
      throw new Error("No video file found in downloads directory");
    }
  }
  
  sub('Extracting frames from video...');
  await exec(
    `ffmpeg -i "${actualVideoPath}" -vf "fps=1" "${FRAMES_DIR}/frame_%04d.png"`,
    { maxBuffer: 100 * 1024 * 1024 }
  );
  const newFrames = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith(".png"));
  done(`${newFrames.length} frames extracted`);
}

// ─── Subtitle Overlay ────────────────────────────────────────
function convertTimestampToFrame(timestamp) {
  const [hours, minutes, seconds] = timestamp.split(":");
  const totalSeconds =
    parseInt(hours) * 3600 +
    parseInt(minutes) * 60 +
    parseFloat(seconds.replace(",", "."));
  return Math.floor(totalSeconds);
}

async function processSubtitles(videoPath) {
  const baseName = path.basename(videoPath, path.extname(videoPath));
  
  // Convert VTT to SRT if needed
  const vttFiles = [
    { vtt: path.join(DOWNLOADS_DIR, `${baseName}.pl.vtt`), srt: path.join(DOWNLOADS_DIR, `${baseName}.pl.srt`) },
    { vtt: path.join(DOWNLOADS_DIR, `${baseName}.en.vtt`), srt: path.join(DOWNLOADS_DIR, `${baseName}.en.srt`) },
  ];
  
  for (const { vtt, srt } of vttFiles) {
    if (fs.existsSync(vtt) && !fs.existsSync(srt)) {
      sub(`Converting ${path.basename(vtt)} to SRT...`);
      convertVTTtoSRT(vtt, srt);
    }
  }
  
  // Check if we have any subtitles
  const plSrtPath = path.join(DOWNLOADS_DIR, `${baseName}.pl.srt`);
  const enSrtPath = path.join(DOWNLOADS_DIR, `${baseName}.en.srt`);
  const transcriptionPlPath = path.join(DOWNLOADS_DIR, `transcription.pl.srt`);
  const transcriptionEnPath = path.join(DOWNLOADS_DIR, `transcription.en.srt`);
  
  const hasPlSubtitles = fs.existsSync(plSrtPath) || fs.existsSync(transcriptionPlPath);
  const hasEnSubtitles = fs.existsSync(enSrtPath) || fs.existsSync(transcriptionEnPath);
  
  // If no subtitles at all, try Whisper transcription
  if (!hasPlSubtitles && !hasEnSubtitles) {
    warn("No subtitles found. Attempting Whisper transcription...");
    
    // Try Polish first
    const plTranscript = await transcribeAudioWithWhisper(videoPath, "pl");
    if (plTranscript) {
      done("Polish transcription completed");
    }
    
    // Try English
    const enTranscript = await transcribeAudioWithWhisper(videoPath, "en");
    if (enTranscript) {
      done("English transcription completed");
    }
    
    if (!plTranscript && !enTranscript) {
      warn("Whisper transcription failed. Book will be generated without dialogue.");
    }
  }
  
  const subtitleFiles = [
    { file: path.join(DOWNLOADS_DIR, `${baseName}.pl.srt`), folder: FRAMES_WITH_SUBTITLES_PL_DIR },
    { file: path.join(DOWNLOADS_DIR, `${baseName}.en.srt`), folder: FRAMES_WITH_SUBTITLES_EN_DIR },
    { file: transcriptionPlPath, folder: FRAMES_WITH_SUBTITLES_PL_DIR },
    { file: transcriptionEnPath, folder: FRAMES_WITH_SUBTITLES_EN_DIR },
  ];
  
  const overlays = [];
  for (const { file, folder } of subtitleFiles) {
    if (fs.existsSync(file)) {
      const outputTextFile = path.join(SUBTITLES_DIR, path.basename(file));
      if (!fs.existsSync(outputTextFile)) {
        fs.copyFileSync(file, outputTextFile);
        console.log(`Subtitles copied to: ${outputTextFile}`);
      }
      overlays.push(overlaySubtitlesOnFrames(file, folder));
    }
  }
  await Promise.all(overlays);
}

async function overlaySubtitlesOnFrames(subtitleFile, outputFolder) {
  sub(`Overlaying subtitles: ${path.basename(subtitleFile)}`);
  const subtitleText = fs.readFileSync(subtitleFile, "utf8");
  const subs = parseSRT(subtitleText);
  const subtitleMap = {};

  for (const s of subs) {
    const escaped = s.text.replace(/:/g, "\\:").replace(/'/g, "\\'");
    subtitleMap[s.startFrame] = escaped;
  }

  const entries = Object.entries(subtitleMap);
  const CONCURRENCY = 8;
  let completed = 0;

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const promises = batch.map(([frameNumber, text]) => {
      const framePath = path.join(
        FRAMES_DIR,
        `frame_${String(frameNumber).padStart(4, "0")}.png`
      );
      const outputFramePath = path.join(
        outputFolder,
        `frame_${String(frameNumber).padStart(4, "0")}.png`
      );
      if (!fs.existsSync(framePath)) return Promise.resolve();
      return exec(
        `ffmpeg -i "${framePath}" -vf "drawtext=text='${text}':fontcolor=white:fontsize=54:x=(w-text_w)/2:y=h-50" -y "${outputFramePath}"`
      )
        .then(() => { completed++; })
        .catch((err) => { completed++; console.error("Error overlaying text on frame:", err.message); });
    });
    await Promise.all(promises);
    if (i + CONCURRENCY < entries.length) {
      process.stdout.write(`   → Subtitle overlay: ${completed}/${entries.length}\r`);
    }
  }
  done(`Subtitle overlay done (${completed} frames)`);
}

// ═════════════════════════════════════════════════════════════
//  Book Pipeline
// ═════════════════════════════════════════════════════════════

async function transcribeAudioWithWhisper(videoPath, language = "pl") {
  sub(`Transcribing audio with Whisper (${language})...`);
  
  // Extract audio from video
  const audioPath = path.join(DOWNLOADS_DIR, `audio_${language}.mp3`);
  
  try {
    // Extract audio using ffmpeg
    await exec(
      `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame -q:a 2 "${audioPath}"`,
      { maxBuffer: 100 * 1024 * 1024 }
    );
    
    sub(`Audio extracted, sending to Whisper...`);
    
    // Transcribe with Whisper
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      language: language,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });
    
    // Convert Whisper segments to SRT format
    const srtPath = path.join(DOWNLOADS_DIR, `transcription.${language}.srt`);
    const srtContent = whisperToSRT(transcription.segments);
    fs.writeFileSync(srtPath, srtContent, "utf8");
    
    done(`Transcription saved (${language})`);
    
    // Clean up audio file
    fs.unlinkSync(audioPath);
    
    return srtPath;
  } catch (error) {
    console.error(`Whisper transcription failed: ${error.message}`);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    return null;
  }
}

function whisperToSRT(segments) {
  const lines = [];
  
  segments.forEach((segment, index) => {
    const startTime = formatSRTTimestamp(segment.start);
    const endTime = formatSRTTimestamp(segment.end);
    const text = segment.text.trim();
    
    if (text) {
      lines.push(index + 1);
      lines.push(`${startTime} --> ${endTime}`);
      lines.push(text);
      lines.push("");
    }
  });
  
  return lines.join("\n");
}

function formatSRTTimestamp(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function loadSubtitles(lang) {
  const dirs = [SUBTITLES_DIR, DOWNLOADS_DIR];
  for (const dir of dirs) {
    const files = fs.readdirSync(dir).filter(
      (f) => (f.includes(`.${lang}.`) || f.includes(`transcription.${lang}.`)) && f.endsWith(".srt")
    );
    if (files.length > 0) {
      return parseSRT(fs.readFileSync(path.join(dir, files[0]), "utf8"));
    }
  }
  return [];
}

function loadExistingAnalyses() {
  const analyses = {};
  if (!fs.existsSync(ANALYSIS_DIR)) return analyses;
  for (const file of fs.readdirSync(ANALYSIS_DIR).filter((f) => f.endsWith(".txt"))) {
    const m = file.match(/frame_(\d+)/);
    if (m) analyses[parseInt(m[1])] = fs.readFileSync(path.join(ANALYSIS_DIR, file), "utf8");
  }
  return analyses;
}

async function detectSceneChanges(threshold = 0.12) {
  const sharp = require("sharp");
  const files = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith(".png")).sort();
  if (files.length === 0) return [];

  const getHash = async (filePath) => {
    const { data } = await sharp(filePath)
      .resize(16, 16, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return data;
  };

  const scenes = [{ frame: files[0], frameNumber: 1, diff: 1.0 }];
  let prevHash = await getHash(path.join(FRAMES_DIR, files[0]));

  for (let i = 1; i < files.length; i++) {
    const currentHash = await getHash(path.join(FRAMES_DIR, files[i]));
    let diff = 0;
    for (let j = 0; j < prevHash.length; j++) {
      diff += Math.abs(prevHash[j] - currentHash[j]);
    }
    diff /= prevHash.length * 255;

    if (diff > threshold) {
      const frameNum = parseInt(files[i].match(/frame_(\d+)/)[1]);
      scenes.push({ frame: files[i], frameNumber: frameNum, diff });
    }
    prevHash = currentHash;
    if (i % 100 === 0) process.stdout.write(`   → Scene detection: ${i}/${files.length}\r`);
  }
  return scenes;
}

function findDialogueGaps(subtitles, totalFrames) {
  if (subtitles.length === 0) return [];
  const gaps = [];

  if (subtitles[0].startFrame > 5) {
    gaps.push({ start: 1, end: subtitles[0].startFrame - 1 });
  }
  for (let i = 0; i < subtitles.length - 1; i++) {
    const gapStart = subtitles[i].endFrame + 1;
    const gapEnd = subtitles[i + 1].startFrame - 1;
    if (gapEnd - gapStart >= 3) {
      gaps.push({
        start: gapStart,
        end: gapEnd,
        prevDialogue: subtitles[i].text,
        nextDialogue: subtitles[i + 1].text,
      });
    }
  }
  const lastEnd = subtitles[subtitles.length - 1].endFrame;
  if (totalFrames - lastEnd >= 5) {
    gaps.push({
      start: lastEnd + 1,
      end: totalFrames,
      prevDialogue: subtitles[subtitles.length - 1].text,
    });
  }
  return gaps;
}

async function analyzeFrameForBook(framePath, context) {
  const imageData = fs.readFileSync(framePath);
  const base64Image = `data:image/png;base64,${imageData.toString("base64")}`;

  const title = (context.cartoonTitle || "Unknown").replace(/'/g, "\\'");
  let ctx = `This is a frame from a children's cartoon called '${title}'.`;
  if (context.prevDialogue) ctx += ` Previous dialogue: "${context.prevDialogue}".`;
  if (context.nextDialogue) ctx += ` Next dialogue: "${context.nextDialogue}".`;

  const response = await openai.chat.completions.create({
    model: "gpt-4.1-mini",
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: `${ctx}\n\nAnalyze this frame:\n1. Is this an important story moment? (yes/no)\n   - "no" if: logo, transition, black screen, credits, static same-as-before\n   - "yes" if: shows important action, new character, emotion, location change\n2. If important, describe the scene in 1 short sentence.\n\nRespond ONLY with valid JSON:\n{"important": true, "description_pl": "Opis po polsku", "description_en": "English description"}\nor\n{"important": false}`,
        },
        { type: "image_url", image_url: { url: base64Image, detail: "low" } },
      ],
    }],
    max_tokens: 150,
    response_format: { type: "json_object" },
  });

  try {
    return JSON.parse(response.choices[0].message.content);
  } catch {
    return { important: false };
  }
}

async function createBook(cartoonTitle = "Unknown") {
  const frameFiles = fs.readdirSync(FRAMES_DIR).filter((f) => f.endsWith(".png")).sort();
  if (frameFiles.length === 0) {
    console.error("No frames found. Run download first.");
    return;
  }

  const subtitlesPL = loadSubtitles("pl");
  const subtitlesEN = loadSubtitles("en");
  const primarySubs = subtitlesPL.length > 0 ? subtitlesPL : subtitlesEN;

  if (primarySubs.length === 0) {
    console.error("No subtitles found. Cannot generate book without dialogue.");
    return;
  }

  sub(`Frames: ${frameFiles.length}, Subtitles: ${subtitlesPL.length} PL / ${subtitlesEN.length} EN`);

  const analyses = loadExistingAnalyses();
  if (Object.keys(analyses).length > 0) sub(`Cached frame analyses: ${Object.keys(analyses).length}`);

  // ── Scene detection ──
  step('Detecting scene changes');
  const sceneChanges = await detectSceneChanges();
  done(`${sceneChanges.length} scene changes found`);

  // ── Find dialogue gaps ──
  const gaps = findDialogueGaps(primarySubs, frameFiles.length);
  sub(`${gaps.length} dialogue gaps (3+ sec)`);

  // ── Select narration candidates from gaps ──
  const narrationCache = {};
  const narrationCacheFile = path.join(BOOK_DIR, "narration-cache.json");
  if (fs.existsSync(narrationCacheFile)) {
    Object.assign(narrationCache, JSON.parse(fs.readFileSync(narrationCacheFile, "utf8")));
  }

  const narrationFrames = [];
  for (const gap of gaps) {
    const scenesInGap = sceneChanges
      .filter((sc) => sc.frameNumber >= gap.start && sc.frameNumber <= gap.end)
      .sort((a, b) => (b.diff || 0) - (a.diff || 0));

    const candidates = scenesInGap.slice(0, 2);
    if (candidates.length === 0 && gap.end - gap.start >= 5) {
      const midFrame = Math.floor((gap.start + gap.end) / 2);
      const midFile = `frame_${String(midFrame).padStart(4, "0")}.png`;
      if (fs.existsSync(path.join(FRAMES_DIR, midFile))) {
        candidates.push({ frame: midFile, frameNumber: midFrame, diff: 0.5 });
      }
    }

    for (const candidate of candidates) {
      const cacheKey = String(candidate.frameNumber);

      let analysis;
      if (narrationCache[cacheKey]) {
        analysis = narrationCache[cacheKey];
      } else if (analyses[candidate.frameNumber]) {
        const existingDesc = analyses[candidate.frameNumber];
        const isSkippable = /logo|credit|text.*polish|blue background|rubber duck.*wrench.*nut|silhouette|black screen|after the movie|www\.|puzzle|gra memory/i.test(existingDesc);
        analysis = isSkippable
          ? { important: false }
          : { important: true, description_en: existingDesc, description_pl: "" };
        narrationCache[cacheKey] = analysis;
      } else {
        console.log(`  Vision AI: frame ${candidate.frameNumber}...`);
        analysis = await analyzeFrameForBook(
          path.join(FRAMES_DIR, candidate.frame),
          { prevDialogue: gap.prevDialogue, nextDialogue: gap.nextDialogue, cartoonTitle }
        );
        narrationCache[cacheKey] = analysis;
      }

      if (analysis.important) {
        narrationFrames.push({
          frameNumber: candidate.frameNumber,
          frame: candidate.frame,
          description_pl: analysis.description_pl || "",
          description_en: analysis.description_en || "",
        });
      }
    }
  }

  fs.writeFileSync(narrationCacheFile, JSON.stringify(narrationCache, null, 2), "utf8");
  done(`${narrationFrames.length} narration frames selected`);

  step('Building story timeline');
  const timeline = buildTimeline(subtitlesPL, subtitlesEN, narrationFrames);
  const keyFrameNumbers = selectKeyFrames(timeline, sceneChanges, frameFiles.length);
  done(`Timeline: ${timeline.length} events, ${keyFrameNumbers.length} key frames`);

  step('Generating PL story (GPT-4.1)');
  const storyPL = await generateBookStory(timeline, keyFrameNumbers, frameFiles.length, "pl", cartoonTitle);
  done(`PL: "${storyPL.title}" — ${storyPL.pages?.length || 0} pages`);

  step('Generating EN story (GPT-4.1)');
  const storyEN = await generateBookStory(timeline, keyFrameNumbers, frameFiles.length, "en", cartoonTitle);
  done(`EN: "${storyEN.title}" — ${storyEN.pages?.length || 0} pages`);

  step('Verifying frame-text alignment (Vision AI)');
  await verifyFramesWithVision(storyPL, analyses, frameFiles.length);
  done('PL verification complete');
  await verifyFramesWithVision(storyEN, analyses, frameFiles.length);
  done('EN verification complete');

  step('Building HTML books');
  buildHTMLBook(storyPL, "pl");
  buildHTMLBook(storyEN, "en");
  done(`PL: ${path.join(BOOK_DIR, "book-pl.html")}`);
  done(`EN: ${path.join(BOOK_DIR, "book-en.html")}`);
}

function buildTimeline(subtitlesPL, subtitlesEN, narrationFrames) {
  const events = [];

  // Group consecutive dialogues into conversation blocks (gap < 4 sec = same block)
  const blocks = [];
  let currentBlock = null;
  for (const sub of subtitlesPL) {
    if (currentBlock && sub.startSec - currentBlock.endSec < 4) {
      currentBlock.lines.push(sub.text);
      currentBlock.endSec = sub.endSec;
      currentBlock.endFrame = sub.endFrame;
    } else {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = {
        startFrame: sub.startFrame,
        endFrame: sub.endFrame,
        startSec: sub.startSec,
        endSec: sub.endSec,
        lines: [sub.text],
      };
    }
  }
  if (currentBlock) blocks.push(currentBlock);

  for (const block of blocks) {
    const combinedPL = block.lines.join(" ");
    const enMatches = subtitlesEN.filter(
      (s) => s.startSec >= block.startSec - 1 && s.endSec <= block.endSec + 1
    );
    const combinedEN = enMatches.map((s) => s.text).join(" ");
    events.push({
      type: "dialogue",
      frameNumber: block.startFrame,
      endFrame: block.endFrame,
      pl: combinedPL,
      en: combinedEN,
    });
  }

  for (const narr of narrationFrames) {
    events.push({
      type: "narration",
      frameNumber: narr.frameNumber,
      pl: narr.description_pl,
      en: narr.description_en,
    });
  }

  events.sort((a, b) => a.frameNumber - b.frameNumber);
  return events;
}

function selectKeyFrames(timeline, sceneChanges, totalFrames) {
  const keySet = new Set();

  const sceneFrames = sceneChanges
    .sort((a, b) => (b.diff || 0) - (a.diff || 0))
    .slice(0, 20)
    .map((s) => s.frameNumber);
  sceneFrames.forEach((f) => keySet.add(f));

  const dialogueStarts = timeline
    .filter((e) => e.type === "dialogue")
    .map((e) => e.frameNumber);
  const step = Math.max(1, Math.floor(dialogueStarts.length / 8));
  for (let i = 0; i < dialogueStarts.length; i += step) {
    keySet.add(dialogueStarts[i]);
  }

  timeline
    .filter((e) => e.type === "narration")
    .forEach((e) => keySet.add(e.frameNumber));

  const sorted = [...keySet].sort((a, b) => a - b);
  if (sorted.length <= 15) return sorted;

  const reduced = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - reduced[reduced.length - 1] >= 5) {
      reduced.push(sorted[i]);
    }
  }
  return reduced.slice(0, 20);
}

async function generateBookStory(timeline, keyFrameNumbers, totalFrames, lang, cartoonTitle = "Unknown") {
  const analyses = loadExistingAnalyses();

  const timelineText = timeline
    .map((e) => {
      const text = lang === "pl" ? (e.pl || e.en) : (e.en || e.pl);
      if (!text) return null;
      const label = e.type === "dialogue" ? "DIALOGUE" : "SCENE";
      const startF = e.frameNumber;
      const endF = e.endFrame || startF;
      const rangeLabel = endF > startF + 5 ? `${startF}-${endF}` : `${startF}`;

      let entry = `[Frame ${rangeLabel}] ${label}: ${e.type === "dialogue" ? `"${text}"` : text}`;

      if (analyses[startF]) {
        entry += `\n  VISUAL(${startF}): ${analyses[startF].substring(0, 120)}`;
      }

      if (endF > startF + 10) {
        const step = Math.max(5, Math.floor((endF - startF) / 5));
        for (let f = startF + step; f <= endF; f += step) {
          if (analyses[f]) {
            entry += `\n  VISUAL(${f}): ${analyses[f].substring(0, 120)}`;
          }
        }
      }

      return entry;
    })
    .filter(Boolean)
    .join("\n");

  const sharp = require("sharp");
  const imageContents = [];
  const maxImages = 10;
  const selectedForImages = keyFrameNumbers.slice(0, maxImages);

  for (const fNum of selectedForImages) {
    const filePath = path.join(FRAMES_DIR, `frame_${String(fNum).padStart(4, "0")}.png`);
    if (fs.existsSync(filePath)) {
      try {
        const resized = await sharp(filePath).resize(512, 288, { fit: "inside" }).jpeg({ quality: 70 }).toBuffer();
        imageContents.push({
          type: "image_url",
          image_url: {
            url: `data:image/jpeg;base64,${resized.toString("base64")}`,
            detail: "low",
          },
        });
        imageContents.push({ type: "text", text: `[Frame ${fNum}]` });
      } catch { /* skip frame if sharp fails */ }
    }
  }

  const titleEscaped = cartoonTitle.replace(/"/g, '\\"');
  const instructions =
    lang === "pl"
      ? `Jesteś autorem książeczek dla małych dzieci (3-5 lat). Na podstawie bajki animowanej "${titleEscaped}" stwórz PEŁNĄ książeczkę obrazkową.

ABSOLUTNIE KLUCZOWA ZASADA — WIERNOŚĆ FAKTOM:
- NIGDY nie wymyślaj wydarzeń, które NIE MA w chronologii poniżej.
- NIGDY nie zmieniaj faktów — jeśli w oryginale postać zrobiła X, to NIE pisz że zrobiła Y.
- Każde zdanie w bajce MUSI mieć pokrycie w danych z chronologii.
- Dialogi postaci cytuj DOKŁADNIE lub bardzo blisko oryginału — nie parafrazuj znacząco.
- Jeśli nie jesteś pewien szczegółu, pomiń go zamiast zmyślać.
- Kolejność wydarzeń musi być IDENTYCZNA jak w chronologii.

STYL:
- Pisz jak bajkę opowiadaną dziecku na dobranoc — ciepło, z emocjami, wciągająco.
- NIE opisuj kolorów przedmiotów, drzew w tle ani dekoracji. Dziecko WIDZI ilustrację — nie musisz jej opisywać!
- Skup się na FABULE, DIALOGACH i UCZUCIACH postaci.
- Używaj krótkich zdań, powtórzeń i dźwiękonaśladowczych słów (brum brum, kwa kwa, puk puk, klang!).
- Dialogi postaci to serce bajki — wplataj je naturalnie, dużo dialogu!

FORMAT:
- Stwórz 25-35 stron. To jest prawdziwa książeczka, nie streszczenie!
- Każda strona: 2-5 PROSTYCH zdań.
- Gdy postacie wymieniają lub liczą przedmioty — wyliczaj po kolei, dzieci lubią listy i liczenie.
- Gdy postać ma pomysł lub rozwiązuje problem — buduj to krok po kroku, żeby dziecko mogło śledzić logikę.
- Gdy są podobne obiekty/zwierzęta (np. zabawka vs. prawdziwe zwierzę) — rozróżniaj je wyraźnie.
- Elementy edukacyjne wyjaśniaj prostymi porównaniami.
- Zakończenie musi być ciepłe i radosne.
- Każda strona musi mieć pole "frame" z numerem klatki (od 1 do ${totalFrames}).
- NIGDY nie powtarzaj tego samego numeru klatki! Wybieraj z RÓŻNYCH momentów bajki.
- Przy wyborze numeru klatki ZAWSZE sprawdź opisy VISUAL w chronologii — wybierz klatke, która NAJLEPIEJ pasuje do tekstu na stronie. NIE wybieraj automatycznie pierwszej klatki z dialogu!

Poniżej widzisz kilka kluczowych klatek jako obrazy.

CHRONOLOGIA BAJKI:
${timelineText}

Odpowiedz TYLKO poprawnym JSON (bez komentarzy, bez markdown):
{"title": "Tytuł bajki", "pages": [{"frame": numer_klatki, "text": "Tekst strony..."}, ...]}`
      : `You are a children's picture book author for ages 3-5. Based on the animated cartoon "${titleEscaped}" data below, create a FULL picture book.

ABSOLUTELY CRITICAL RULE — FACTUAL ACCURACY:
- NEVER invent events that are NOT in the chronology below.
- NEVER change facts — if in the original a character did X, do NOT write that they did Y.
- Every sentence in the book MUST be supported by data from the chronology.
- Quote character dialogue EXACTLY or very close to the original — do not significantly paraphrase.
- If you're unsure about a detail, skip it rather than making it up.
- Event order must be IDENTICAL to the chronology.

STYLE:
- Write like a bedtime story told to a child — warm, emotional, engaging.
- Do NOT describe colors of objects, trees in the background, or decorations. The child SEES the illustration — you don't need to describe it!
- Focus on PLOT, DIALOGUE, and CHARACTER FEELINGS.
- Use short sentences, repetition, onomatopoeia (vroom vroom, quack quack, knock knock, clang!).
- Character dialogues are the heart of the story — use them generously and naturally!

FORMAT:
- Create 25-35 pages. This is a real picture book, NOT a summary!
- Each page: 2-5 SIMPLE sentences.
- When characters list or count items — narrate each one, kids love lists and counting.
- When a character has a clever idea or solves a problem — build it up step by step so the child can follow the logic.
- When there are similar objects/creatures (e.g. a toy vs. a real animal) — distinguish them clearly.
- Educational parts — explain with simple comparisons kids understand.
- Ending must be warm and happy.
- Each page needs a "frame" field with frame number (1 to ${totalFrames}).
- NEVER repeat the same frame number! Pick from DIFFERENT moments.
- When choosing frame numbers, ALWAYS check the VISUAL descriptions in the chronology — pick the frame whose VISUAL best matches the page text. Do NOT default to the first frame of a dialogue!

Below you can see some key frames as images.

CARTOON CHRONOLOGY:
${timelineText}

Respond ONLY with valid JSON (no comments, no markdown):
{"title": "Story title", "pages": [{"frame": frame_number, "text": "Page text..."}, ...]}`;

  const attemptGeneration = async (withImages) => {
    const content = withImages
      ? [{ type: "text", text: instructions }, ...imageContents]
      : [{ type: "text", text: instructions }];

    const response = await openai.chat.completions.create({
      model: "gpt-4.1",
      messages: [{ role: "user", content }],
      max_tokens: 10000,
      response_format: { type: "json_object" },
    });
    return JSON.parse(response.choices[0].message.content);
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const useImages = attempt <= 2;
      if (attempt > 1) {
        const delay = attempt * 5000;
        console.log(`  Retry ${attempt}/3 ${useImages ? "(with images)" : "(text only)"} in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
      const parsed = await attemptGeneration(useImages);
      console.log(`  ${lang.toUpperCase()} story: "${parsed.title}" — ${parsed.pages?.length || 0} pages`);
      return parsed;
    } catch (error) {
      const isQuota = error.message?.includes("429") || error.message?.includes("quota");
      if (isQuota) {
        console.error(`  ${lang.toUpperCase()}: OpenAI quota exceeded. Check billing at platform.openai.com`);
        return { title: lang === "pl" ? "Bajka" : "Story", pages: [] };
      }
      console.warn(`  Attempt ${attempt} failed: ${error.message}`);
    }
  }
  console.error(`  ${lang.toUpperCase()}: All attempts failed.`);
  return { title: lang === "pl" ? "Bajka" : "Story", pages: [] };
}

async function verifyFramesWithVision(story, analyses, totalFrames) {
  if (!story.pages || story.pages.length === 0) return;

  const sharp = require("sharp");
  const usedFrames = new Set();
  let visionFixes = 0;

  for (let i = 0; i < story.pages.length; i++) {
    const page = story.pages[i];
    const currentFrame = page.frame;
    const prevFrame = i > 0 ? story.pages[i - 1].frame : 1;
    const nextFrame = i < story.pages.length - 1 ? story.pages[i + 1].frame : totalFrames;

    const lo = Math.max(prevFrame + 1, currentFrame - 20);
    const hi = Math.min(nextFrame > currentFrame ? nextFrame - 1 : totalFrames, currentFrame + 20);

    const candidates = [currentFrame];
    const step = Math.max(2, Math.floor((hi - lo) / 5));
    for (let f = lo; f <= hi; f += step) {
      if (f !== currentFrame && !usedFrames.has(f)) {
        const fp = path.join(FRAMES_DIR, `frame_${String(f).padStart(4, "0")}.png`);
        if (fs.existsSync(fp)) candidates.push(f);
      }
    }
    if (!candidates.includes(hi) && hi !== currentFrame && !usedFrames.has(hi)) {
      const fp = path.join(FRAMES_DIR, `frame_${String(hi).padStart(4, "0")}.png`);
      if (fs.existsSync(fp)) candidates.push(hi);
    }
    candidates.sort((a, b) => a - b);
    const uniqueCandidates = [...new Set(candidates)].slice(0, 8);

    if (uniqueCandidates.length <= 1) {
      usedFrames.add(currentFrame);
      continue;
    }

    const imageContent = [];
    for (const fNum of uniqueCandidates) {
      const fp = path.join(FRAMES_DIR, `frame_${String(fNum).padStart(4, "0")}.png`);
      try {
        const buf = await sharp(fp).resize(384, 216, { fit: "inside" }).jpeg({ quality: 60 }).toBuffer();
        imageContent.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${buf.toString("base64")}`, detail: "low" },
        });
        imageContent.push({ type: "text", text: `[Frame ${fNum}]` });
      } catch { /* skip */ }
    }

    if (imageContent.length < 4) {
      usedFrames.add(currentFrame);
      continue;
    }

    try {
      const prompt = `You are matching a children's book page to the best illustration frame.

PAGE TEXT: "${page.text}"

Above are ${uniqueCandidates.length} candidate frames. Pick the ONE frame whose visual content best matches the page text. Consider:
- Characters shown (who is visible, what are they doing)
- Objects mentioned in the text (tools, map, phone, duck, excavator, etc.)
- The ACTION described (is someone kneeling? talking on phone? holding something?)
- Narrative timing (if text says "duck is hiding", don't pick a frame showing the duck visible)

Respond with ONLY the frame number, nothing else. Example: 445`;

      const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
        max_tokens: 20,
      });

      const chosen = parseInt(response.choices[0].message.content.trim());
      if (!isNaN(chosen) && uniqueCandidates.includes(chosen)) {
        if (chosen !== currentFrame) {
          console.log(`  Vision fix p${i + 1}: frame ${currentFrame} → ${chosen} ("${page.text.substring(0, 45)}...")`);
          page.frame = chosen;
          visionFixes++;
        }
        usedFrames.add(chosen);
      } else {
        usedFrames.add(currentFrame);
      }
    } catch (err) {
      console.warn(`  Vision verify p${i + 1} failed: ${err.message}`);
      usedFrames.add(currentFrame);
    }
  }

  // Enforce chronological ordering
  let chronoFixes = 0;
  for (let i = 1; i < story.pages.length; i++) {
    if (story.pages[i].frame <= story.pages[i - 1].frame) {
      const minAllowed = story.pages[i - 1].frame + 1;
      if (minAllowed <= totalFrames) {
        console.log(`  Chrono fix: p${i + 1} frame ${story.pages[i].frame} → ${minAllowed}`);
        story.pages[i].frame = minAllowed;
        chronoFixes++;
      }
    }
  }

  console.log(`  Vision verification: ${visionFixes} fix(es), ${chronoFixes} chrono fix(es).`);
}

function buildHTMLBook(story, lang) {
  if (!story.pages || story.pages.length === 0) {
    console.error(`No pages for ${lang} book.`);
    return;
  }

  for (const page of story.pages) {
    const frameFile = `frame_${String(page.frame).padStart(4, "0")}.png`;
    const src = path.join(FRAMES_DIR, frameFile);
    const dest = path.join(BOOK_DIR, frameFile);
    if (fs.existsSync(src) && !fs.existsSync(dest)) {
      fs.copyFileSync(src, dest);
    }
  }

  const langLabel = lang === "pl" ? "pl" : "en";
  const prevLabel = lang === "pl" ? "&#8592; Wstecz" : "&#8592; Back";
  const nextLabel = lang === "pl" ? "Dalej &#8594;" : "Next &#8594;";
  const endText = lang === "pl" ? "Koniec" : "The End";

  const pagesHTML = story.pages
    .map((page, i) => {
      const frameFile = `frame_${String(page.frame).padStart(4, "0")}.png`;
      const escaped = page.text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const formattedText = escaped.replace(
        /—\s*([^—]+?)(?=\s*—|\s*$)/g,
        '<span class="dialogue">— $1</span>'
      );

      return `
    <section class="page" data-page="${i + 1}">
      <div class="page-inner">
        <div class="illustration">
          <img src="${frameFile}" alt="Page ${i + 1}" loading="lazy">
        </div>
        <div class="text-area">
          <p>${formattedText}</p>
        </div>
        <div class="page-num">${i + 1} / ${story.pages.length}</div>
      </div>
    </section>`;
    })
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="${langLabel}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>${story.title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body {
      height: 100%; width: 100%;
      overflow: hidden;
      font-family: 'Nunito', 'Segoe UI', sans-serif;
      background: #1a1a2e;
      color: #2d2d2d;
      -webkit-tap-highlight-color: transparent;
      user-select: none;
    }

    .book-container {
      width: 100%; height: 100%;
      position: relative;
      overflow: hidden;
    }

    /* ── Cover ── */
    .cover {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      z-index: 10;
      transition: opacity 0.6s ease, transform 0.6s ease;
    }
    .cover.hidden { opacity: 0; pointer-events: none; transform: scale(1.05); }
    .cover h1 {
      font-size: clamp(28px, 5vw, 52px);
      font-weight: 800;
      color: #fff;
      text-align: center;
      padding: 0 30px;
      text-shadow: 0 3px 12px rgba(0,0,0,0.3);
      line-height: 1.3;
    }
    .cover .start-btn {
      margin-top: 40px;
      padding: 16px 48px;
      font-size: 22px;
      font-weight: 700;
      font-family: inherit;
      border: none;
      border-radius: 50px;
      background: #fff;
      color: #764ba2;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      transition: transform 0.2s;
    }
    .cover .start-btn:hover { transform: scale(1.05); }

    /* ── End page ── */
    .end-page {
      position: absolute; inset: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      background: linear-gradient(135deg, #f093fb 0%, #f5576c 100%);
      z-index: 10;
      opacity: 0; pointer-events: none;
      transition: opacity 0.6s ease;
    }
    .end-page.visible { opacity: 1; pointer-events: auto; }
    .end-page h1 {
      font-size: clamp(36px, 6vw, 64px);
      font-weight: 800;
      color: #fff;
      text-shadow: 0 3px 12px rgba(0,0,0,0.2);
    }
    .end-page .restart-btn {
      margin-top: 30px;
      padding: 14px 40px;
      font-size: 20px;
      font-weight: 700;
      font-family: inherit;
      border: none;
      border-radius: 50px;
      background: #fff;
      color: #f5576c;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
      transition: transform 0.2s;
    }
    .end-page .restart-btn:hover { transform: scale(1.05); }

    /* ── Pages ── */
    .page {
      position: absolute; inset: 0;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(180deg, #fdf6f0 0%, #f0e6d8 100%);
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.5s ease, transform 0.5s ease;
      transform: translateX(60px);
    }
    .page.active {
      opacity: 1; pointer-events: auto; transform: translateX(0);
    }
    .page.exit-left {
      opacity: 0; transform: translateX(-60px);
    }

    .page-inner {
      width: 100%; height: 100%;
      max-width: 900px;
      display: flex; flex-direction: column;
      padding: 16px 20px;
    }

    .illustration {
      flex: 0 0 62%;
      display: flex; align-items: center; justify-content: center;
      min-height: 0;
      padding: 8px;
    }
    .illustration img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.15);
    }

    .text-area {
      flex: 1 1 0;
      min-height: 0;
      overflow-y: auto;
      padding: 16px 24px 8px;
      text-align: center;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .text-area p {
      font-size: clamp(16px, 2.5vw, 24px);
      line-height: 1.6;
      font-weight: 600;
      color: #3d3225;
    }
    .dialogue {
      color: #5b4ac4;
      font-style: italic;
    }

    .page-num {
      text-align: center;
      font-size: 14px;
      color: #a09080;
      padding-bottom: 8px;
      font-weight: 600;
    }

    /* ── Navigation ── */
    .nav-bar {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 24px;
      z-index: 100;
      pointer-events: none;
    }
    .nav-btn {
      pointer-events: auto;
      padding: 12px 28px;
      font-size: 18px;
      font-weight: 700;
      font-family: inherit;
      border: none;
      border-radius: 50px;
      cursor: pointer;
      transition: transform 0.15s, opacity 0.3s;
      box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    }
    .nav-btn:hover { transform: scale(1.05); }
    .nav-btn:active { transform: scale(0.95); }
    .nav-btn.hidden { opacity: 0; pointer-events: none; }
    .nav-prev {
      background: rgba(255,255,255,0.92);
      color: #555;
    }
    .nav-next {
      background: #667eea;
      color: #fff;
    }

    @media (max-width: 600px) {
      .page-inner { padding: 10px 12px; }
      .text-area { padding: 12px 16px 4px; }
      .nav-btn { padding: 10px 20px; font-size: 16px; }
    }
  </style>
</head>
<body>
  <div class="book-container">
    <div class="cover" id="cover">
      <h1>${story.title}</h1>
      <button class="start-btn" onclick="startBook()">${lang === "pl" ? "Zaczynamy!" : "Let's read!"}</button>
    </div>

    <div class="end-page" id="endPage">
      <h1>${endText} &#127775;</h1>
      <button class="restart-btn" onclick="restart()">${lang === "pl" ? "Przeczytaj jeszcze raz" : "Read again"}</button>
    </div>

${pagesHTML}
  </div>

  <div class="nav-bar" id="navBar" style="display:none;">
    <button class="nav-btn nav-prev" id="prevBtn" onclick="prevPage()">${prevLabel}</button>
    <button class="nav-btn nav-next" id="nextBtn" onclick="nextPage()">${nextLabel}</button>
  </div>

  <script>
    const pages = document.querySelectorAll('.page');
    const totalPages = pages.length;
    let currentPage = 0;

    function showPage(n) {
      pages.forEach((p, i) => {
        p.classList.remove('active', 'exit-left');
        if (i < n) p.classList.add('exit-left');
        if (i === n) p.classList.add('active');
      });
      document.getElementById('prevBtn').classList.toggle('hidden', n === 0);
      document.getElementById('endPage').classList.remove('visible');
    }

    function startBook() {
      document.getElementById('cover').classList.add('hidden');
      document.getElementById('navBar').style.display = 'flex';
      currentPage = 0;
      showPage(0);
    }

    function nextPage() {
      if (currentPage < totalPages - 1) {
        currentPage++;
        showPage(currentPage);
      } else {
        document.getElementById('endPage').classList.add('visible');
      }
    }

    function prevPage() {
      if (currentPage > 0) {
        currentPage--;
        showPage(currentPage);
      }
    }

    function restart() {
      document.getElementById('endPage').classList.remove('visible');
      document.getElementById('cover').classList.remove('hidden');
      document.getElementById('navBar').style.display = 'none';
      pages.forEach(p => p.classList.remove('active', 'exit-left'));
      currentPage = 0;
    }

    // Keyboard navigation
    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        if (document.getElementById('cover').classList.contains('hidden')) nextPage();
        else startBook();
      }
      if (e.key === 'ArrowLeft') { e.preventDefault(); prevPage(); }
    });

    // Touch swipe
    let touchStartX = 0;
    document.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
    document.addEventListener('touchend', (e) => {
      const diff = touchStartX - e.changedTouches[0].clientX;
      if (Math.abs(diff) > 50) {
        if (diff > 0) {
          if (document.getElementById('cover').classList.contains('hidden')) nextPage();
          else startBook();
        } else {
          prevPage();
        }
      }
    }, { passive: true });
  </script>
</body>
</html>`;

  fs.writeFileSync(path.join(BOOK_DIR, `book-${lang}.html`), html, "utf8");
}

// ═════════════════════════════════════════════════════════════
//  Main Orchestrator
// ═════════════════════════════════════════════════════════════
async function main() {
  const args = process.argv.slice(2);
  const videoUrl = args.find((a) => !a.startsWith("--"));
  const bookOnly = args.includes("--book");

  if (!videoUrl && !bookOnly) {
    console.error(
      'Usage:\n' +
      '  node index.js "YOUTUBE_URL"   Download video and generate picture book\n' +
      '  node index.js --book          Regenerate book from existing downloads'
    );
    process.exit(1);
  }

  await installDeps();

  let cartoonTitle = "Unknown";
  let videoId;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║           LinkToTale — Picture Book Pipeline      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (videoUrl) {
    videoId = extractVideoId(videoUrl);
    initDirectories(videoId);

    step('Getting video info');
    cartoonTitle = await getVideoTitle(videoUrl);
    done(`Title: "${cartoonTitle}"`);
    done(`Video ID: ${videoId}`);

    step('Downloading video + subtitles');
    const outputTemplate = path.join(DOWNLOADS_DIR, "%(title)s");
    await downloadVideo(videoUrl, outputTemplate);
    const videoPath = await getVideoFilename(videoUrl, outputTemplate);
    done('Download complete');

    step('Extracting frames (1 FPS)');
    await extractFrames(videoPath);

    step('Processing subtitles');
    await processSubtitles(videoPath);
  } else {
    // --book mode: find most recent video folder
    videoId = findExistingVideoFolder();
    if (!videoId) {
      console.error("No existing video folders found in downloads/");
      process.exit(1);
    }
    initDirectories(videoId);

    step('Loading existing data');
    done(`Folder: ${videoId}`);
    cartoonTitle = getCartoonTitleFromDownloads();
    if (cartoonTitle !== "Unknown") done(`Title: "${cartoonTitle}"`);
    
    // Find the video file for potential transcription
    const files = fs.readdirSync(DOWNLOADS_DIR);
    const videoFile = files.find((f) => 
      /\.(mp4|mkv|webm|avi|mov|m4a)$/i.test(f) || 
      (!f.includes('.') && fs.statSync(path.join(DOWNLOADS_DIR, f)).isFile())
    );
    
    if (videoFile) {
      step('Processing subtitles');
      const videoPath = path.join(DOWNLOADS_DIR, videoFile);
      await processSubtitles(videoPath);
    }
  }

  step('Generating picture book');
  await createBook(cartoonTitle);
  
  console.log(`\n📁 All files saved in: downloads/${videoId}/`);
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║                    All done!                     ║');
  console.log('╚══════════════════════════════════════════════════╝');
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
