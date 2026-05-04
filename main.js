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
let lastHeartbeatPong = Date.now();
let heartbeatInterval = null;
let unresponsiveTimer = null;

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
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Reset renderer-ready + heartbeat state if the page reloads
  mainWindow.webContents.on('did-start-loading', () => {
    rendererReady = false;
    lastHeartbeatPong = Date.now(); // pause watchdog during reload
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => log('Page load failed', code, desc));

  // Auto-recover from renderer crash
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log('Renderer process gone:', details.reason);
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) {
      log('Reloading renderer after crash');
      try { mainWindow.reload(); } catch (e) { log('Reload after crash failed:', e.message); }
    }
  });

  // Auto-recover from renderer hang
  mainWindow.on('unresponsive', () => {
    log('Renderer unresponsive');
    if (unresponsiveTimer) clearTimeout(unresponsiveTimer);
    unresponsiveTimer = setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        log('Renderer still unresponsive after 5s, reloading');
        try { mainWindow.reload(); } catch (e) { log('Reload after hang failed:', e.message); }
      }
    }, 5000);
  });
  mainWindow.on('responsive', () => {
    log('Renderer responsive again');
    if (unresponsiveTimer) { clearTimeout(unresponsiveTimer); unresponsiveTimer = null; }
  });

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; rendererReady = false; });
}

function showOverlay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  // Sanity-check position: if window drifted off all displays (monitor unplugged,
  // resolution change, DPI change), recenter on primary so the user can see it.
  const b = mainWindow.getBounds();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const onScreen = screen.getAllDisplays().some(d =>
    cx >= d.workArea.x && cx <= d.workArea.x + d.workArea.width &&
    cy >= d.workArea.y && cy <= d.workArea.y + d.workArea.height
  );
  if (!onScreen) {
    const primary = screen.getPrimaryDisplay();
    const { width, height } = primary.workAreaSize;
    mainWindow.setBounds({
      x: primary.workArea.x + Math.round((width - 260) / 2),
      y: primary.workArea.y + height - 84,
      width: 260,
      height: 44
    });
    log('Window was off-screen, recentered to primary display');
  }

  if (!mainWindow.isVisible()) mainWindow.showInactive();   // no focus steal
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
}

// --- Tray ---
function createTray() {
  const icon = loadTrayIcon();
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Start / Stop Recording', click: () => triggerRecording() },
    { label: 'Fenster zeigen', click: () => showOverlay() },
    { type: 'separator' },
    { label: 'Settings', click: () => { showOverlay(); mainWindow?.webContents.send('show-settings'); } },
    { label: 'Auf Updates prüfen', click: () => checkForUpdates(false) },
    { label: 'Renderer neu laden', click: () => {
        try { mainWindow?.reload(); log('Manual renderer reload from tray'); }
        catch (e) { log('Manual reload failed:', e.message); }
      }
    },
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
let rendererReady = false;
let pendingTrigger = false;

function triggerRecording() {
  if (!mainWindow) {
    log('triggerRecording: no mainWindow');
    return;
  }
  showOverlay();

  // If renderer hasn't signaled ready, queue the trigger and try when it does.
  if (!rendererReady) {
    log('triggerRecording: renderer not ready, queuing');
    pendingTrigger = true;
    return;
  }

  try {
    mainWindow.webContents.send('toggle-recording');
    log('triggerRecording: sent toggle-recording');
  } catch (e) {
    log('triggerRecording: send failed:', e.message);
    // retry once after short delay
    setTimeout(() => {
      try { mainWindow?.webContents.send('toggle-recording'); }
      catch (e2) { log('triggerRecording retry failed:', e2.message); }
    }, 100);
  }
}

// --- Hotkey ---
let hotkeyHealthCheckInterval = null;

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

  // Health check: every 30s verify the hotkey is still registered.
  // Some apps / Windows can steal it temporarily; re-register if lost.
  if (hotkeyHealthCheckInterval) clearInterval(hotkeyHealthCheckInterval);
  hotkeyHealthCheckInterval = setInterval(() => {
    if (!globalShortcut.isRegistered(primary)) {
      log('Hotkey lost! Re-registering', primary);
      for (const acc of candidates) {
        try { globalShortcut.register(acc, triggerRecording); } catch {}
      }
    }
  }, 30000);
}

// --- Renderer health watchdog ---
// Sends a ping every 30s; renderer pongs back. If we don't hear a pong
// for >90s, the renderer is hung and we reload it.
function startHeartbeatWatchdog() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  lastHeartbeatPong = Date.now();
  heartbeatInterval = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const since = Date.now() - lastHeartbeatPong;
    if (since > 90000) {
      log('Heartbeat watchdog: no pong for', since, 'ms - reloading renderer');
      try {
        mainWindow.reload();
        lastHeartbeatPong = Date.now(); // reset cooldown so we don't immediately re-trigger
      } catch (e) {
        log('Watchdog reload failed:', e.message);
      }
      return;
    }
    try { mainWindow.webContents.send('heartbeat-ping'); }
    catch (e) { log('Heartbeat ping failed:', e.message); }
  }, 30000);
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

  // Renderer signals it's ready to receive IPC events
  ipcMain.handle('renderer-ready', () => {
    rendererReady = true;
    lastHeartbeatPong = Date.now();
    log('Renderer ready');
    // Flush any pending hotkey-triggered recording
    if (pendingTrigger) {
      pendingTrigger = false;
      log('Flushing pending trigger');
      setTimeout(() => mainWindow?.webContents.send('toggle-recording'), 50);
    }
  });

  // Renderer responds to watchdog ping
  ipcMain.handle('heartbeat-pong', () => {
    lastHeartbeatPong = Date.now();
  });
  ipcMain.handle('resize-for-settings', (_e, expand) => {
    if (expand) mainWindow?.setSize(340, 600);
    else mainWindow?.setSize(260, 44);
  });
  ipcMain.handle('resize-for-result', (_e, expand) => {
    if (expand) mainWindow?.setSize(260, 110);
    else mainWindow?.setSize(260, 44);
  });

  ipcMain.handle('download-update', () => startUpdateDownload());
  ipcMain.handle('install-update', () => quitAndInstallUpdate());
  ipcMain.handle('check-for-updates', (_e, silent) => checkForUpdates(silent !== false));
}

// --- Second instance handler ---
app.on('second-instance', () => {
  log('Second instance attempted - focusing existing');
  if (mainWindow) {
    showOverlay();
    mainWindow.webContents.send('toggle-recording');
  }
});

// --- Auto-Updater ---
// Uses electron-updater to fetch releases from GitHub.
// Flow: app start -> check -> notify renderer -> user clicks Download
//       -> download with progress -> notify ready -> user clicks Restart -> install.
const { autoUpdater } = require('electron-updater');
let lastUpdateCheckSilent = true;

autoUpdater.autoDownload = false;        // wait for user click
autoUpdater.autoInstallOnAppQuit = false; // we trigger install ourselves
autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

autoUpdater.on('checking-for-update', () => {
  log('autoUpdater: checking for update');
});
autoUpdater.on('update-available', (info) => {
  log('autoUpdater: update available', info.version);
  mainWindow?.webContents.send('update-available', {
    version: info.version,
    notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : ''
  });
});
autoUpdater.on('update-not-available', (info) => {
  log('autoUpdater: up to date', info.version);
  if (!lastUpdateCheckSilent) {
    mainWindow?.webContents.send('update-status', { upToDate: true, version: info.version });
  }
});
autoUpdater.on('error', (err) => {
  log('autoUpdater error:', err?.message || String(err));
  mainWindow?.webContents.send('update-error', { message: err?.message || 'Unknown error' });
});
autoUpdater.on('download-progress', (p) => {
  mainWindow?.webContents.send('update-download-progress', {
    percent: Math.round(p.percent),
    bytesPerSecond: p.bytesPerSecond,
    transferred: p.transferred,
    total: p.total
  });
});
autoUpdater.on('update-downloaded', (info) => {
  log('autoUpdater: update downloaded', info.version);
  mainWindow?.webContents.send('update-downloaded', { version: info.version });
});

function checkForUpdates(silent = true) {
  lastUpdateCheckSilent = silent;
  if (!app.isPackaged) {
    log('checkForUpdates skipped: app not packaged (dev mode)');
    if (!silent) {
      mainWindow?.webContents.send('update-status', { upToDate: true, version: app.getVersion() });
    }
    return Promise.resolve({ available: false, dev: true });
  }
  return autoUpdater.checkForUpdates().catch((e) => {
    log('checkForUpdates failed:', e.message);
    return { error: e.message };
  });
}

function startUpdateDownload() {
  if (!app.isPackaged) {
    log('startUpdateDownload skipped: dev mode');
    return;
  }
  log('Starting update download');
  autoUpdater.downloadUpdate().catch((e) => {
    log('downloadUpdate failed:', e.message);
    mainWindow?.webContents.send('update-error', { message: e.message });
  });
}

function quitAndInstallUpdate() {
  log('Quitting and installing update');
  app.isQuitting = true;
  // isSilent=false (show installer), isForceRunAfter=true (relaunch after install)
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
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
  startHeartbeatWatchdog();

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
