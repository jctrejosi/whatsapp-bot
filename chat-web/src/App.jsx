import { useState, useEffect, useRef, useCallback } from 'react';
import { chat, getSources, getSource, ingestPdf, healthCheck, getSettings, updateSettings, resetSettings, sendTestEmail, getLogs } from './api.js';

/* ─── Message Bubble ──────────────────── */
function MessageBubble({ msg }) {
  const [showSources, setShowSources] = useState(false);

  const isUser = msg.role === 'user';

  return (
    <div className={`message ${isUser ? 'user' : 'bot'}`}>
      {!isUser && <div className="label">🤖 Quinceañera Bot</div>}
      {isUser && <div className="label">Tú</div>}
      <div className="bubble">{msg.text}</div>

      {!isUser && msg.chunks && msg.chunks.length > 0 && (
        <>
          <span className="sources-toggle" onClick={() => setShowSources(!showSources)}>
            {showSources ? '▲ Ocultar fuentes' : '▼ Ver fuentes usadas'} ({msg.chunks.length})
          </span>
          {showSources && (
            <div className="sources-list">
              {msg.chunks.map((c, i) => (
                <div key={i} className="source-item">
                  <strong>Fuente {i + 1}</strong> — fragmento {c.chunk_index}
                  <br />
                  {c.content.substring(0, 150)}...
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ─── Typing Indicator ────────────────── */
function TypingIndicator() {
  return (
    <div className="message bot">
      <div className="label">🤖 Quinceañera Bot</div>
      <div className="bubble">
        <div className="typing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    </div>
  );
}

/* ─── Chat Panel ──────────────────────── */
function ChatPanel({ online }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const messagesEnd = useRef(null);
  const queue = useRef([]);
  const sending = useRef(false);

  const scrollToBottom = useCallback(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => scrollToBottom(), [messages, loading]);

  const sendOne = useCallback(async (text) => {
    sending.current = true;
    setLoading(true);
    try {
      const data = await chat(text);
      setMessages((prev) => [
        ...prev,
        { role: 'bot', text: data.answer, chunks: data.chunks_used || [] },
      ]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'bot', text: '❌ ' + err.message }]);
    } finally {
      setLoading(false);
      sending.current = false;
    }
  }, []);

  // When the bot finishes a response, send the next queued message (if any)
  useEffect(() => {
    if (!loading && !sending.current && queue.current.length > 0) {
      const next = queue.current.shift();
      setQueueCount(queue.current.length);
      sendOne(next);
    }
  }, [loading, sendOne]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !online) return;

    setInput('');

    if (loading || sending.current) {
      // Enqueue: show message immediately, send after current response
      setMessages((prev) => [...prev, { role: 'user', text }]);
      queue.current.push(text);
      setQueueCount(queue.current.length);
    } else {
      setMessages((prev) => [...prev, { role: 'user', text }]);
      sendOne(text);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-panel">
      <div className="messages">
        {!online && (
          <div className="message bot">
            <div className="label">🤖 Quinceañera Bot</div>
            <div className="bubble">
              ⏳ Conectando con el servicio...
            </div>
          </div>
        )}
        {online && messages.length === 0 && (
          <div className="message bot">
            <div className="label">🤖 Quinceañera Bot</div>
            <div className="bubble">
              ¡Hola! Soy el asistente del crucero de Quinceañeras a bordo del MSC World America (20-27 marzo 2027). Pregúntame lo que quieras sobre el evento.
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} msg={msg} />
        ))}
        {loading && <TypingIndicator />}
        <div ref={messagesEnd} />
      </div>

      <div className="input-area">
        <input
          type="text"
          placeholder={online ? 'Escribe tu pregunta sobre el crucero...' : 'Servicio no disponible — esperando conexión...'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!online}
        />
        <button
          className="btn btn-primary"
          onClick={handleSend}
          disabled={!online || !input.trim()}
        >
          {loading ? '⏳' : 'Enviar'}
        </button>
      </div>
      {queueCount > 0 && (
        <div className="queue-indicator">
          ⏳ {queueCount} mensaje{queueCount > 1 ? 's' : ''} encolado{queueCount > 1 ? 's' : ''} — se enviarán en cuanto termine la respuesta
        </div>
      )}
    </div>
  );
}

/* ─── Upload Panel ────────────────────── */
function UploadPanel({ onRefresh }) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type === 'application/pdf') {
      await handleUpload(file);
    } else {
      setStatus('Solo se aceptan archivos PDF');
    }
  };

  const handleFileSelect = async (e) => {
    const file = e.target.files?.[0];
    if (file) await handleUpload(file);
  };

  const handleUpload = async (file) => {
    setUploading(true);
    setStatus(`Subiendo ${file.name}...`);
    setProgress(10);

    try {
      const result = await ingestPdf(file);
      setStatus('Procesando... extrayendo texto');

      // Poll until done
      let done = false;
      let attempts = 0;
      while (!done && attempts < 60) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
        try {
          const src = await getSource(result.source_id);
          setProgress(src.last_job?.progress || progress);
          setStatus(src.last_job?.status || 'procesando');
          if (src.last_job?.status === 'completed') {
            done = true;
            setStatus('✅ ¡Ingesta completada!');
            onRefresh?.();
          } else if (src.last_job?.status === 'failed') {
            done = true;
            setStatus('❌ Error: ' + (src.last_job?.error_message || 'desconocido'));
          }
        } catch {
          // still polling
        }
      }
      if (!done) setStatus('⏱️ Timeout — revisa manualmente');
    } catch (err) {
      setStatus('❌ Error: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="sidebar-section">
      <h3>📄 Subir conocimiento</h3>
      <div
        className={`upload-zone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => document.getElementById('file-input').click()}
      >
        {uploading ? '⏳ Procesando...' : 'Arrastra un PDF aquí\n o haz clic para seleccionar'}
        <input
          id="file-input"
          type="file"
          accept=".pdf"
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>
      {uploading && (
        <div className="upload-progress">
          <div className="progress-bar">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="upload-status">{status}</div>
        </div>
      )}
      {status && !uploading && <div className="upload-status">{status}</div>}
    </div>
  );
}

/* ─── Source List ─────────────────────── */
function SourceList({ refreshKey }) {
  const [sources, setSources] = useState([]);
  const [selectedSource, setSelectedSource] = useState(null);
  const [sourceDetail, setSourceDetail] = useState(null);
  const [loading, setLoading] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const data = await getSources();
      setSources(data);
    } catch {
      // silently fail
    }
  }, []);

  // Carga al montar y cuando se pide refresco (subida de PDF o botón ↻)
  useEffect(() => {
    loadSources();
  }, [loadSources, refreshKey]);

  const handleSelect = async (source) => {
    if (selectedSource?.id === source.id) {
      setSelectedSource(null);
      setSourceDetail(null);
      return;
    }
    setSelectedSource(source);
    setLoading(true);
    try {
      const detail = await getSource(source.id);
      setSourceDetail(detail);
    } catch {
      setSourceDetail(null);
    } finally {
      setLoading(false);
    }
  };

  const statusBadge = (status) => {
    const cls = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'processing';
    return <span className={`badge ${cls}`}>{status}</span>;
  };

  return (
    <>
      <div className="sidebar-section source-header">
        <h3>📚 Base de conocimiento ({sources.length})</h3>
        <button className="btn btn-secondary btn-sm" onClick={loadSources} title="Refrescar lista">
          ↻
        </button>
      </div>
      <div className="source-list">
        {sources.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--gray-200)', padding: 10 }}>
            No hay documentos. Sube un PDF para empezar.
          </div>
        )}
        {sources.map((s) => (
          <div key={s.id}>
            <div className="source-card" onClick={() => handleSelect(s)}>
              <div className="source-title">{s.title}</div>
              <div className="source-meta">
                {statusBadge(s.status)}
                <span>{s.original_filename}</span>
              </div>
            </div>
            {selectedSource?.id === s.id && sourceDetail && (
              <div className="source-detail">
                <p style={{ fontSize: 12, marginBottom: 8, color: 'var(--gray-200)' }}>
                  {sourceDetail.documents?.[0]?.page_count} páginas · {sourceDetail.documents?.[0]?.char_count} caracteres
                </p>
                {sourceDetail.documents?.[0]?.chunks?.map((c) => (
                  <div key={c.id} className="chunk-item">
                    <div className="chunk-header">
                      <span>Fragmento {c.index}</span>
                      <span>{c.char_count} chars {c.has_embedding ? '✓' : '✗'}</span>
                    </div>
                    <div>{c.content_preview}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ─── Settings Panel (admin) ───────────── */
function SliderRow({ label, hint, value, min, max, step, onChange }) {
  return (
    <div className="settings-row">
      <div className="row-top">
        <label>{label}</label>
        <span className="value">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
      {hint && <p className="settings-hint">{hint}</p>}
    </div>
  );
}

function SettingsPanel({ open, onClose }) {
  const [settings, setSettings] = useState(null);
  const [newEmail, setNewEmail] = useState('');
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState('');

  useEffect(() => {
    if (!open) return;
    setMsg('');
    setTestResult('');
    getSettings()
      .then(setSettings)
      .catch((e) => setMsg('❌ No se pudo cargar: ' + e.message));
  }, [open]);

  if (!open || !settings) return null;

  const set = (key, value) => setSettings((s) => ({ ...s, [key]: value }));

  const addEmail = () => {
    const email = newEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setMsg('❌ Correo inválido');
      return;
    }
    if (settings.escalationEmails.includes(email)) {
      setMsg('❌ Ese correo ya está en la lista');
      return;
    }
    set('escalationEmails', [...settings.escalationEmails, email]);
    setNewEmail('');
    setMsg('');
  };

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      setSettings(await updateSettings(settings));
      onClose();
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (!window.confirm('¿Restablecer todos los valores a los predeterminados?')) return;
    setSaving(true);
    setMsg('');
    try {
      setSettings(await resetSettings());
      setMsg('✅ Valores restablecidos');
    } catch (e) {
      setMsg('❌ ' + e.message);
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult('');
    try {
      const res = await sendTestEmail();
      if (res.ok) {
        setTestResult('✅ Correo enviado a: ' + res.results.map((r) => r.to).join(', '));
      } else {
        const failed = res.results.filter((r) => !r.ok);
        setTestResult('❌ Falló: ' + failed.map((r) => r.to + ': ' + r.error).join(' | '));
      }
    } catch (e) {
      setTestResult('❌ ' + e.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>⚙️ Configuración</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="settings-section">
            <h3>📧 Notificación a asesores</h3>
            <p className="settings-hint">
              Correos que reciben el aviso cuando un cliente pide hablar con un asesor.
            </p>
            {settings.escalationEmails.map((email, i) => (
              <div className="email-row" key={i}>
                <span>{email}</span>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() =>
                    set('escalationEmails', settings.escalationEmails.filter((_, j) => j !== i))
                  }
                >
                  Quitar
                </button>
              </div>
            ))}
            <div className="email-add">
              <input
                type="email"
                placeholder="asesor@correo.com"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addEmail()}
              />
              <button className="btn btn-primary btn-sm" onClick={addEmail}>Agregar</button>
            </div>
            <div className="email-add">
              <span className="email-add-label">Remitente</span>
              <input
                type="email"
                placeholder="bot@tudominio.com"
                value={settings.senderEmail}
                onChange={(e) => set('senderEmail', e.target.value)}
              />
            </div>
            <p className="settings-hint">
              El remitente debe usar un dominio verificado en Resend. Puedes probar con
              onboarding@resend.dev mientras verificas tu dominio.
            </p>
            <button className="btn btn-secondary btn-sm" onClick={test} disabled={testing}>
              {testing ? 'Enviando...' : '📨 Enviar correo de prueba'}
            </button>
            {testResult && <div className="settings-status">{testResult}</div>}
          </div>

          <div className="settings-section">
            <h3>🎛️ Sensibilidad y calidad de respuestas</h3>
            <div className="settings-row">
              <div className="row-top">
                <label>Modelo DeepSeek</label>
                <span className="value">{settings.model}</span>
              </div>
              <select
                className="model-select"
                value={settings.model}
                onChange={(e) => set('model', e.target.value)}
              >
                <option value="deepseek-v4-flash">⚡ DeepSeek V4 Flash (rápido)</option>
                <option value="deepseek-v3">📦 DeepSeek V3</option>
                <option value="deepseek-v3-lite">💨 DeepSeek V3 Lite</option>
                <option value="deepseek-r1">🧠 DeepSeek R1 (razonamiento)</option>
                <option value="deepseek-chat">💬 DeepSeek Chat (V4 Pro)</option>
              </select>
            </div>
            <SliderRow
              label="Creatividad (temperature)"
              hint="Más alto = respuestas más variadas y naturales; más bajo = más consistentes."
              value={settings.temperature}
              min={0} max={1.5} step={0.05}
              onChange={(v) => set('temperature', v)}
            />
            <SliderRow
              label="Fragmentos de conocimiento (top_k)"
              hint="Cuántos fragmentos del PDF se usan para armar cada respuesta."
              value={settings.topK}
              min={1} max={10} step={1}
              onChange={(v) => set('topK', v)}
            />
            <SliderRow
              label="Mensajes de contexto (historial)"
              hint="Cuántos turnos previos se envían al modelo en cada pregunta para mantener el contexto."
              value={settings.maxHistoryMessages}
              min={1} max={30} step={1}
              onChange={(v) => set('maxHistoryMessages', v)}
            />
            <SliderRow
              label="Confianza mínima de búsqueda"
              hint="Similitud mínima (0-1) para que un fragmento se considere relevante. 0 = sin filtro."
              value={settings.minConfidence}
              min={0} max={1} step={0.05}
              onChange={(v) => set('minConfidence', v)}
            />
            <SliderRow
              label="Máximo de tokens por respuesta"
              hint="Tope de la primera respuesta del modelo."
              value={settings.maxTokens}
              min={256} max={4096} step={128}
              onChange={(v) => set('maxTokens', v)}
            />
            <SliderRow
              label="Intentos sin respuesta clara"
              hint="Si el bot no encuentra respuesta en N intentos seguidos, ofrece contactar a un asesor. 0 = desactivado."
              value={settings.maxNegativeResponses}
              min={0} max={20} step={1}
              onChange={(v) => set('maxNegativeResponses', v)}
            />
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={settings.useReranker}
                onChange={(e) => set('useReranker', e.target.checked)}
              />
              <span>Usar reranker (DeepSeek V4 Pro) en la búsqueda</span>
            </label>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Guardando...' : '💾 Guardar cambios'}
          </button>
          <button className="btn btn-secondary" onClick={reset} disabled={saving}>
            ↺ Restablecer
          </button>
          {msg && <span className="settings-status">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

/* ─── Logs Panel ──────────────────────── */
function LogsPanel({ open, onClose }) {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    getLogs(80).then(setLogs).catch(() => {});
  }, [open]);

  const refresh = async () => {
    setLoading(true);
    try { setLogs(await getLogs(80)); } catch {}
    finally { setLoading(false); }
  };

  if (!open) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>📋 Logs del backend</h2>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-secondary btn-sm" onClick={refresh} disabled={loading}>
              {loading ? 'Cargando...' : '↻ Refrescar'}
            </button>
            <button className="btn btn-secondary btn-sm" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body">
          <div className="logs-list">
            {logs.length === 0 && (
              <p className="settings-hint">No hay logs aún. Los eventos de envío de correo y errores aparecerán aquí.</p>
            )}
            {logs.map((entry, i) => (
              <div key={i} className={`log-entry log-${entry.level}`}>
                <div className="log-header">
                  <span className={`log-level log-${entry.level}`}>{entry.level.toUpperCase()}</span>
                  <span className="log-time">{entry.timestamp}</span>
                </div>
                <div className="log-message">{entry.message}</div>
                {entry.error && <div className="log-detail">Error: {entry.error}</div>}
                {entry.to && <div className="log-detail">Para: {entry.to}</div>}
                {entry.userId && <div className="log-detail">Usuario: {entry.userId}</div>}
                {entry.reason && <div className="log-detail">Motivo: {entry.reason}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Header ──────────────────────────── */
function Header({ status, error }) {
  const label =
    status === true ? '✅ API conectada' :
    status === false ? '🔴 ' + (error || 'API desconectada') :
    '⏳ Verificando conexión...';
  const cls = status === true ? 'online' : status === false ? 'offline' : '';

  return (
    <div className="header">
      <h1>🚢 Quinceañera Cruise — Knowledge Chat</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
        {cls && <span className={`status-dot ${cls}`} />}
        <span style={{ color: 'var(--gray-200)' }}>{label}</span>
      </div>
    </div>
  );
}

/* ─── App ─────────────────────────────── */
export default function App() {
  const [online, setOnline] = useState(null);
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [sourcesVersion, setSourcesVersion] = useState(0);

  useEffect(() => {
    const check = async () => {
      const result = await healthCheck();
      setOnline(result.ok);
      if (!result.ok && result.status) {
        setError(`Error ${result.status}`);
      } else if (!result.ok) {
        setError('Sin conexión');
      } else {
        setError('');
      }
    };
    // Al cargar y al volver a la pestaña (sin polling continuo)
    check();
    window.addEventListener('focus', check);
    return () => window.removeEventListener('focus', check);
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-section">
          <button className="btn btn-secondary btn-block" onClick={() => setSettingsOpen(true)}>
            ⚙️ Configuración
          </button>
          <button
            className="btn btn-secondary btn-block"
            style={{ marginTop: 6 }}
            onClick={() => setLogsOpen(true)}
          >
            📋 Logs
          </button>
        </div>
        <UploadPanel onRefresh={() => setSourcesVersion((v) => v + 1)} />
        <SourceList refreshKey={sourcesVersion} />
      </aside>
      <main className="main">
        <Header status={online} error={error} />
        <ChatPanel online={online === true} />
      </main>
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}
