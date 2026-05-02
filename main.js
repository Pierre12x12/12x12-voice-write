const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, clipboard, nativeImage, screen, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { exec } = require('child_process');

// Single instance lock - prevents multiple copies running at once
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

// Migrate old voiceink config to new 12x12-voicewrite folder
// (so existing users don't lose their API key after rename)
try {
  const oldDir = path.join(app.getPath('appData'), 'voiceink');
  const newDir = path.join(app.getPath('appData'), '12x12-voicewrite');
  if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
    fs.mkdirSync(newDir, { recursive: true });
    for (const f of fs.readdirSync(oldDir)) {
      try { fs.copyFileSync(path.join(oldDir, f), path.join(newDir, f)); } catch {}
    }
  }
} catch {}

// Override userData so the config sits in 12x12-voicewrite/ (grouped under 12x12 brand)
app.setPath('userData', path.join(app.getPath('appData'), '12x12-voicewrite'));

// Log everything to a file so we can debug
let LOG_FILE = null;
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')}\n`;
  try {
    if (!LOG_FILE && app.isReady()) LOG_FILE = path.join(app.getPath('userData'), 'app.log');
    if (LOG_FILE) fs.appendFileSync(LOG_FILE, line);
  } catch {}
  console.log(...args);
}

let store, autoLauncher;
let mainWindow = null;
let tray = null;

function initStore() {
  const Store = require('electron-store');
  store = new Store({
    defaults: {
      apiKey: '',
      llmPrompt: 'Du erhältst transkribierten gesprochenen Text auf Deutsch. Korrigiere Grammatik, Zeichensetzung und Großschreibung. Behalte die deutsche Sprache und den Sinn EXAKT bei. ÜBERSETZE NIEMALS in eine andere Sprache. Gib AUSSCHLIESSLICH den korrigierten deutschen Text aus, ohne Erklärungen, Anführungszeichen oder Kommentare.',
      hotkey: 'F9',
      autoStart: true,
      autoPaste: false,
      llmModel: 'llama-3.3-70b-versatile',
      whisperModel: 'whisper-large-v3-turbo',
      language: 'de',
      enhanceEnabled: true
    }
  });
}

function initAutoLaunch() {
  const AutoLaunch = require('auto-launch');
  const appPath = app.isPackaged
    ? app.getPath('exe')
    : path.join(__dirname, 'start-silent.vbs');
  autoLauncher = new AutoLaunch({
    name: '12x12 Voice Write',
    path: appPath,
    isHidden: true
  });
}

function loadTrayIcon() {
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  return nativeImage.createEmpty();
}

// --- API ---
function apiRequest(hostname, apiPath, apiKey, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname,
      path: apiPath,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let result = '';
      res.on('data', (chunk) => result += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(result);
            return reject(new Error(err.error?.message || `API error ${res.statusCode}`));
          } catch {
            return reject(new Error(`API error ${res.statusCode}: ${result.slice(0, 200)}`));
          }
        }
        try { resolve(JSON.parse(result)); }
        catch { reject(new Error('Invalid API response')); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function whisperTranscribe(audioPath, apiKey, language, model) {
  return new Promise((resolve, reject) => {
    const FormData = require('form-data');
    const form = new FormData();
    // Explicit filename + content type so Groq picks the right decoder
    form.append('file', fs.createReadStream(audioPath), {
      filename: 'audio.webm',
      contentType: 'audio/webm'
    });
    form.append('model', model || 'whisper-large-v3-turbo');
    if (language) form.append('language', language);
    form.append('response_format', 'json');
    form.append('temperature', '0');

    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        ...form.getHeaders(),
        'Authorization': `Bearer ${apiKey}`
      }
    }, (res) => {
      let result = '';
      res.on('data', (chunk) => result += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          try {
            const err = JSON.parse(result);
            return reject(new Error(err.error?.message || `Whisper error ${res.statusCode}`));
          } catch {
            return reject(new Error(`Whisper error ${res.statusCode}`));
          }
        }
        try { resolve(JSON.parse(result).text); }
        catch { reject(new Error('Invalid Whisper response')); }
      });
    });
    req.on('error', reject);
    form.pipe(req);
  });
}

// --- Window ---
function createMainWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 260,
    height: 44,
    minHeight: 44,
    maxHeight: 600,
    x: Math.round((width - 260) / 2),
    y: height - 84,
    show: false,                      // start hidden
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',     // fully transparent (no black flash)
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false     // keep working when hidden
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showOverlay() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.showInactive();   // no focus steal
}

// --- Tray ---
function createTray() {
  const icon = loadTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Start / Stop Recording', click: () => triggerRecording() },
    { label: 'Settings', click: () => { showOverlay(); mainWindow?.webContents.send('show-settings'); } },
    { label: 'Auf Updates prüfen', click: () => checkForUpdates(false) },
    { type: 'separator' },
    { label: 'Toggle DevTools (debug)', click: () => mainWindow?.webContents.toggleDevTools({ mode: 'detach' }) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } }
  ]);

  tray.setToolTip('12x12 Voice Write – Hotkey drücken zum Aufnehmen');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => triggerRecording());
}

// --- Recording trigger ---
function triggerRecording() {
  if (!mainWindow) return;
  showOverlay();
  // tiny delay so the window is ready to receive the IPC
  setTimeout(() => mainWindow.webContents.send('toggle-recording'), 30);
}

// --- Hotkey ---
function registerHotkey() {
  globalShortcut.unregisterAll();
  const primary = store.get('hotkey');

  // For numpad combos, also register the NumLock=OFF equivalent
  const candidates = new Set([primary]);
  if (primary === 'Control+num1') candidates.add('Control+End');
  if (primary === 'Control+num2') candidates.add('Control+Down');
  if (primary === 'Control+num3') candidates.add('Control+PageDown');

  for (const acc of candidates) {
    try {
      const ok = globalShortcut.register(acc, triggerRecording);
      log('Hotkey register', acc, ok ? 'OK' : 'FAILED');
    } catch (e) {
      log('Hotkey error', acc, e.message);
    }
  }
}

// --- IPC ---
function setupIPC() {
  ipcMain.handle('transcribe', async (_event, audioBuffer) => {
    const apiKey = store.get('apiKey');
    if (!apiKey) throw new Error('No API key configured. Open Settings first.');

    const tempPath = path.join(app.getPath('temp'), `12x12vw-${Date.now()}.webm`);
    fs.writeFileSync(tempPath, Buffer.from(audioBuffer));
    log('Transcribing audio. Size:', audioBuffer.byteLength, 'bytes');

    try {
      const text = await whisperTranscribe(tempPath, apiKey, store.get('language'), store.get('whisperModel'));
      log('Transcription result:', text?.slice(0, 100));
      return text;
    } catch (e) {
      log('Transcription error:', e.message);
      throw e;
    } finally {
      try { fs.unlinkSync(tempPath); } catch {}
    }
  });

  ipcMain.handle('enhance', async (_event, text) => {
    if (!store.get('enhanceEnabled')) return text;
    const apiKey = store.get('apiKey');
    if (!apiKey) return text;

    const result = await apiRequest('api.groq.com', '/openai/v1/chat/completions', apiKey, {
      model: store.get('llmModel'),
      messages: [
        { role: 'system', content: store.get('llmPrompt') },
        { role: 'user', content: text }
      ],
      temperature: 0.3
    });

    return result.choices?.[0]?.message?.content || text;
  });

  ipcMain.handle('paste-text', async (_event, text) => {
    clipboard.writeText(text);

    if (store.get('autoPaste')) {
      mainWindow?.hide();
      return new Promise((resolve) => {
        setTimeout(() => {
          const cmd = 'powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"';
          exec(cmd, () => resolve(true));
        }, 250);
      });
    }
    return true;
  });

  ipcMain.handle('get-settings', () => store.store);

  ipcMain.handle('save-settings', async (_event, settings) => {
    for (const [key, value] of Object.entries(settings)) store.set(key, value);
    registerHotkey();

    if (autoLauncher && settings.autoStart !== undefined) {
      try {
        if (settings.autoStart) await autoLauncher.enable();
        else await autoLauncher.disable();
      } catch {}
    }
    return true;
  });

  ipcMain.handle('open-settings', () => {
    showOverlay();
    mainWindow?.setSize(340, 600);
    mainWindow?.webContents.send('show-settings');
  });

  ipcMain.handle('hide-window', () => {
    mainWindow?.setSize(260, 44);
    mainWindow?.hide();
  });
  ipcMain.handle('show-window', () => showOverlay());
  ipcMain.handle('open-external', (_e, url) => require('electron').shell.openExternal(url));
  ipcMain.handle('resize-for-settings', (_e, expand) => {
    if (expand) mainWindow?.setSize(340, 600);
    else mainWindow?.setSize(260, 44);
  });
  ipcMain.handle('resize-for-result', (_e, expand) => {
    if (expand) mainWindow?.setSize(260, 110);
    else mainWindow?.setSize(260, 44);
  });
}

// --- Second instance handler ---
app.on('second-instance', () => {
  log('Second instance attempted - focusing existing');
  if (mainWindow) {
    showOverlay();
    mainWindow.webContents.send('toggle-recording');
  }
});

// --- Update Check ---
// Polls a JSON file on 12x12 hosting and shows a notification if a newer version exists.
// JSON format: {"version": "1.0.1", "url": "https://.../12x12-Voice-Write-Setup-1.0.1.exe", "notes": "..."}
const UPDATE_MANIFEST_URL = 'https://netzwerk12xx12.web.app/downloads/voicewrite-latest.json';

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function checkForUpdates(silent = true) {
  return new Promise((resolve) => {
    https.get(UPDATE_MANIFEST_URL, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const manifest = JSON.parse(body);
          const current = app.getVersion();
          const latest = manifest.version;
          log('Update check: current', current, 'latest', latest);
          if (compareVersions(latest, current) > 0) {
            log('Update available:', latest);
            mainWindow?.webContents.send('update-available', {
              version: latest,
              url: manifest.url,
              notes: manifest.notes || ''
            });
            resolve({ available: true });
          } else {
            if (!silent) {
              mainWindow?.webContents.send('update-status', { upToDate: true, version: current });
            }
            resolve({ available: false });
          }
        } catch (e) {
          log('Update check parse error:', e.message);
          resolve({ error: e.message });
        }
      });
    }).on('error', (e) => {
      log('Update check failed:', e.message);
      resolve({ error: e.message });
    });
  });
}

// --- Lifecycle ---
app.whenReady().then(() => {
  initStore();
  initAutoLaunch();
  log('App started. Config path:', app.getPath('userData'));
  log('API key configured:', !!store.get('apiKey'));
  log('Hotkey:', store.get('hotkey'));

  // Auto-grant microphone permission for our own renderer
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media' || permission === 'audioCapture' || permission === 'microphone') {
      callback(true);
    } else {
      callback(false);
    }
  });
  session.defaultSession.setPermissionCheckHandler(() => true);

  createMainWindow();
  createTray();
  registerHotkey();
  setupIPC();

  // If no API key set, show overlay so user can configure
  if (!store.get('apiKey')) {
    setTimeout(() => {
      showOverlay();
      mainWindow?.webContents.send('show-settings');
    }, 500);
  }

  if (autoLauncher && store.get('autoStart')) {
    autoLauncher.enable().catch(() => {});
  }

  // Check for updates after 5s, then every 6h
  setTimeout(() => checkForUpdates(true), 5000);
  setInterval(() => checkForUpdates(true), 6 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => {});
app.on('before-quit', () => { app.isQuitting = true; });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('activate', () => { if (!mainWindow) createMainWindow(); });
