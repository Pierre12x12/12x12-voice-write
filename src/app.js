const $ = (sel) => document.querySelector(sel);
const scannerEl = $('#scanner');
const statusEl = $('#status');
const resultEl = $('#result');
const resultText = $('#result-text');
const appEl = $('#app');

let state = 'idle'; // idle | recording | processing | success | error
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;

// Status texts only used internally + for accessibility (#status is visually hidden)
const STATUS = {
  idle:       '',
  recording:  'Aufnahme',
  transcribe: 'Transkribiere',
  enhance:    'KI-Korrektur',
  success:    'Kopiert',
  short:      'Zu kurz',
  noSpeech:   'Keine Sprache',
  micDenied:  'Mikro verweigert',
  micErr:     'Mikro-Fehler',
  noKey:      'API-Key fehlt'
};

function setState(newState, statusText) {
  appEl.classList.remove('recording', 'processing', 'success', 'error');
  state = newState;
  if (newState !== 'idle') appEl.classList.add(newState);
  if (statusText !== undefined) statusEl.textContent = statusText;
}

// ---- Recording ----
async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    });

    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      if (blob.size < 4000) {
        setState('error', STATUS.short);
        setTimeout(() => setState('idle', STATUS.idle), 2000);
        return;
      }
      await processAudio(blob);
    };

    mediaRecorder.start();
    setState('recording', STATUS.recording);

  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      setState('error', STATUS.micDenied);
    } else {
      setState('error', STATUS.micErr);
    }
    setTimeout(() => setState('idle', STATUS.idle), 3000);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// ---- Processing ----
async function processAudio(blob) {
  setState('processing', STATUS.transcribe);
  resultEl.classList.remove('visible');

  try {
    const buffer = await blob.arrayBuffer();
    const rawText = await window.api.transcribe(buffer);

    if (!rawText || !rawText.trim()) {
      setState('error', STATUS.noSpeech);
      setTimeout(() => setState('idle', STATUS.idle), 2500);
      return;
    }

    setState('processing', STATUS.enhance);
    const enhanced = await window.api.enhance(rawText);
    const finalText = (enhanced || rawText).trim();

    resultText.textContent = finalText;
    resultEl.classList.add('visible');
    window.api.resizeForResult(true);

    await window.api.pasteText(finalText);
    setState('success', STATUS.success);

    setTimeout(() => {
      setState('idle', STATUS.idle);
      resultEl.classList.remove('visible');
      window.api.resizeForResult(false);
      setTimeout(() => window.api.hideWindow(), 200);
    }, 3500);

  } catch (err) {
    const msg = err.message || 'Fehler';
    setState('error', msg.length > 48 ? msg.slice(0, 48) + '...' : msg);
    if (msg.includes('API key') || msg.includes('Incorrect API') || msg.includes('Invalid API')) {
      setTimeout(() => showSettings(), 1500);
    }
    setTimeout(() => setState('idle', STATUS.idle), 4000);
  }
}

// ---- Click on scanner = same as hotkey ----
scannerEl.addEventListener('click', () => triggerToggle());

function triggerToggle() {
  if (state === 'processing' || state === 'success') return;
  if (state === 'recording') stopRecording();
  else { resultEl.classList.remove('visible'); startRecording(); }
}

// ---- Global Hotkey Handler with debounce ----
let lastToggle = 0;
window.api.onToggleRecording(() => {
  const now = Date.now();
  if (now - lastToggle < 300) return;
  lastToggle = now;
  triggerToggle();
});

// ---- Settings ----
function showSettings() {
  window.api.resizeForSettings(true);
  appEl.classList.add('has-settings');
  $('#settings-panel').classList.add('visible');
  loadSettings();
}
function hideSettings() {
  $('#settings-panel').classList.remove('visible');
  setTimeout(() => {
    appEl.classList.remove('has-settings');
    window.api.resizeForSettings(false);
  }, 280);
}

async function loadSettings() {
  const s = await window.api.getSettings();
  $('#api-key').value = s.apiKey || '';
  $('#llm-model').value = s.llmModel || 'llama-3.3-70b-versatile';
  $('#whisper-model').value = s.whisperModel || 'whisper-large-v3-turbo';
  $('#hotkey').value = s.hotkey || 'F9';
  $('#language').value = s.language ?? 'de';
  $('#llm-prompt').value = s.llmPrompt || '';
  $('#enhance-enabled').checked = s.enhanceEnabled !== false;
  $('#auto-paste').checked = s.autoPaste === true;
  $('#auto-start').checked = s.autoStart !== false;
}

async function saveSettings() {
  const settings = {
    apiKey: $('#api-key').value.trim(),
    llmModel: $('#llm-model').value,
    whisperModel: $('#whisper-model').value,
    hotkey: $('#hotkey').value,
    language: $('#language').value,
    llmPrompt: $('#llm-prompt').value,
    enhanceEnabled: $('#enhance-enabled').checked,
    autoPaste: $('#auto-paste').checked,
    autoStart: $('#auto-start').checked
  };
  await window.api.saveSettings(settings);
  hideSettings();
  setState('idle', 'Gespeichert!');
  setTimeout(() => { if (state === 'idle') statusEl.textContent = STATUS.idle; }, 1200);
}

$('#settings-btn').addEventListener('click', showSettings);
$('#settings-close').addEventListener('click', hideSettings);
$('#save-btn').addEventListener('click', saveSettings);
$('#close-btn').addEventListener('click', () => window.api.hideWindow());
window.api.onShowSettings(() => showSettings());

// ---- Update notifications ----
window.api.onUpdateAvailable((info) => {
  resultText.innerHTML = `<span style="color:#34D399">● Update v${info.version}</span> – <a href="#" id="update-link" style="color:#60A5FA;text-decoration:underline">jetzt downloaden</a>`;
  resultEl.classList.add('visible');
  window.api.resizeForResult(true);
  window.api.showWindow();
  document.getElementById('update-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.api.openExternal(info.url);
  });
  // Auto-hide after 15s
  setTimeout(() => {
    resultEl.classList.remove('visible');
    window.api.resizeForResult(false);
  }, 15000);
});

window.api.onUpdateStatus((info) => {
  if (info.upToDate) {
    resultText.textContent = `Aktuell (v${info.version})`;
    resultEl.classList.add('visible');
    window.api.resizeForResult(true);
    window.api.showWindow();
    setTimeout(() => {
      resultEl.classList.remove('visible');
      window.api.resizeForResult(false);
    }, 3000);
  }
});

// ---- Init ----
(async () => {
  const s = await window.api.getSettings();
  if (!s.apiKey) {
    setState('idle', STATUS.noKey);
    setTimeout(showSettings, 800);
  }
})();
